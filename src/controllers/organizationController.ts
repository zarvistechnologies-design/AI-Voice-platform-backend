import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { startSession, type ClientSession } from "mongoose";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { AuthSessionModel } from "../models/AuthSession.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { OrganizationModel } from "../models/Organization.js";
import { OrganizationInvitationModel } from "../models/OrganizationInvitation.js";
import { OrganizationMemberModel, type OrganizationRole } from "../models/OrganizationMember.js";
import { toPublicUser, UserModel } from "../models/User.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelDomainModel } from "../models/WhiteLabelDomain.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { organizationInvitationEmail } from "../services/emailTemplates.js";
import {
  emailBrandForRequest,
  resolveBrandForOrganization,
  resolveWhiteLabelRequestContext,
  type WhiteLabelRequestContext,
} from "../services/whiteLabelService.js";
import { createOrganization } from "../services/organizationService.js";
import { setAuthCookie, setRefreshCookie } from "../utils/authCookie.js";
import { HttpError } from "../utils/httpError.js";
import { signAuthToken } from "../utils/jwt.js";

function context(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  return { user: request.user, organization: request.organization };
}

function inviteRole(value: unknown): Exclude<OrganizationRole, "owner"> {
  if (value === "admin" || value === "member" || value === "billing") return value;
  throw new HttpError(400, "Invitation role must be admin, member, or billing.");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listOrganizations(request: AuthenticatedRequest, response: Response) {
  const { user, organization } = context(request);
  const memberships = await OrganizationMemberModel.find({ userId: user.id })
    .populate({
      path: "orgId",
      match: request.whiteLabel
        ? {
            whiteLabelAccountId: request.whiteLabel.accountId,
            whiteLabelBrandId: request.whiteLabel.brandId,
            lifecycleStatus: { $ne: "archived" },
          }
        : { whiteLabelAccountId: { $exists: false }, lifecycleStatus: { $ne: "archived" } },
    })
    .sort({ createdAt: 1 });
  const visibleOrganizations: Array<Record<string, unknown> & { role: OrganizationRole }> = memberships
    .filter((membership) => membership.orgId)
    .map((membership) => ({
      ...(membership.orgId as unknown as { toObject(): Record<string, unknown> }).toObject(),
      role: membership.role,
    }));
  const wlOrgIds = visibleOrganizations
    .filter((item) => item.whiteLabelAccountId)
    .map((item) => item._id);
  const subscriptions = wlOrgIds.length
    ? await WhiteLabelSubscriptionModel.find({ orgId: { $in: wlOrgIds } })
        .select("orgId planNameSnapshot featuresSnapshot")
        .lean()
    : [];
  const subByOrgId = new Map(subscriptions.map((sub) => [String(sub.orgId), sub]));
  response.json({
    activeOrganizationId: organization.id,
    organizations: visibleOrganizations.map((item) => {
      const sub = subByOrgId.get(String(item._id));
      return sub
        ? {
            ...item,
            ...(sub.planNameSnapshot ? { whiteLabelPlanName: sub.planNameSnapshot } : {}),
            ...(sub.featuresSnapshot ? { whiteLabelFeatures: sub.featuresSnapshot } : {}),
          }
        : item;
    }),
  });
}

export async function createOrganizationWorkspace(request: AuthenticatedRequest, response: Response) {
  const { user } = context(request);
  if (request.whiteLabel) {
    throw new HttpError(403, "New branded customer workspaces must be provisioned by the account administrator.");
  }
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, "Organization name must be between 2 and 100 characters.");
  }
  const organization = await createOrganization({ name, ownerUserId: user.id });
  await recordAuditLog(request, {
    orgId: organization.id,
    action: "organization.created",
    resource: "organization",
    resourceId: organization.id,
    after: { name: organization.name, slug: organization.slug, plan: organization.plan },
  });
  if (request.sessionId) {
    await AuthSessionModel.updateOne({ tokenId: request.sessionId }, { orgId: organization._id, lastSeenAt: new Date() });
  }
  setAuthCookie(response, signAuthToken(user.id, organization.id, request.sessionId));
  response.status(201).json({ organization: { ...organization.toObject(), role: "owner" } });
}

export async function updateCurrentOrganization(request: AuthenticatedRequest, response: Response) {
  const { organization } = context(request);
  const org = await OrganizationModel.findById(organization.id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const before = {
    name: org.name,
    settings: org.settings,
  };
  if ("name" in request.body) {
    const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
    if (name.length < 2 || name.length > 100) {
      throw new HttpError(400, "Organization name must be between 2 and 100 characters.");
    }
    org.name = name;
  }
  if (typeof request.body.timezone === "string") {
    org.set("settings.timezone", request.body.timezone.trim() || "UTC");
  }
  if (typeof request.body.dataRetentionDays === "number") {
    org.set("settings.dataRetentionDays", Math.min(3650, Math.max(1, request.body.dataRetentionDays)));
  }
  await org.save();
  await recordAuditLog(request, {
    action: "organization.updated",
    resource: "organization",
    resourceId: org.id,
    before,
    after: { name: org.name, settings: org.settings },
  });
  response.json({ organization: { ...org.toObject(), role: organization.role } });
}

export async function switchOrganization(request: AuthenticatedRequest, response: Response) {
  const { user } = context(request);
  const membership = await OrganizationMemberModel.findOne({
    userId: user.id,
    orgId: request.params.orgId,
  });
  if (!membership) throw new HttpError(403, "You are not a member of this organization.");
  const target = await OrganizationModel.findById(membership.orgId);
  if (!target || target.lifecycleStatus !== "active") throw new HttpError(403, "This organization is not active.");
  if (request.whiteLabel && (
    String(target.whiteLabelAccountId ?? "") !== request.whiteLabel.accountId ||
    String(target.whiteLabelBrandId ?? "") !== request.whiteLabel.brandId
  )) {
    throw new HttpError(403, "This organization is not available on the current branded domain.");
  }
  if (!request.whiteLabel && target.whiteLabelAccountId) {
    throw new HttpError(403, "Open this organization from its branded domain.");
  }
  if (request.sessionId) {
    await AuthSessionModel.updateOne({ tokenId: request.sessionId }, { orgId: membership.orgId, lastSeenAt: new Date() });
  }
  setAuthCookie(response, signAuthToken(user.id, String(membership.orgId), request.sessionId));
  response.status(204).end();
}

export async function listMembers(request: AuthenticatedRequest, response: Response) {
  const { organization } = context(request);
  const [members, invitations] = await Promise.all([
    OrganizationMemberModel.find({ orgId: organization.id })
      .populate("userId", "name email createdAt")
      .sort({ createdAt: 1 }),
    OrganizationInvitationModel.find({ orgId: organization.id, status: "pending" })
      .select("-tokenHash")
      .sort({ createdAt: -1 }),
  ]);
  response.json({ members, invitations });
}

export async function inviteMember(request: AuthenticatedRequest, response: Response) {
  const { user, organization } = context(request);
  const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
  const role = inviteRole(request.body.role);
  const existingUser = await UserModel.findOne({ email });
  const token = randomBytes(32).toString("hex");
  const invitationTokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitationSession = await startSession();
  try {
    await invitationSession.withTransaction(async () => {
      if (organization.whiteLabelAccountId) {
        const subscription = await WhiteLabelSubscriptionModel.findOneAndUpdate(
          {
            orgId: organization.id,
            accountId: organization.whiteLabelAccountId,
            status: { $in: ["trialing", "active"] },
          },
          { $inc: { capacityRevision: 1 } },
          { new: true, session: invitationSession },
        ).select("+capacityRevision limitsSnapshot featuresSnapshot");
        if (!subscription) throw new HttpError(402, "An active customer subscription is required to invite team members.");
        const features = (subscription.featuresSnapshot ?? {}) as Record<string, unknown>;
        if (features.teamAccess !== true) throw new HttpError(403, "Team access is not included in this customer plan.");
        const memberLimit = Math.max(0, Number((subscription.limitsSnapshot as Record<string, unknown>)?.members ?? 0));
        const [memberCount, pendingCount] = await Promise.all([
          OrganizationMemberModel.countDocuments({ orgId: organization.id }).session(invitationSession),
          OrganizationInvitationModel.countDocuments({
            orgId: organization.id,
            status: "pending",
            expiresAt: { $gt: new Date() },
            email: { $ne: email },
          }).session(invitationSession),
        ]);
        if (memberCount + pendingCount >= memberLimit) {
          throw new HttpError(409, `Team member limit of ${memberLimit} reached for this plan.`);
        }
      }
      if (existingUser && await OrganizationMemberModel.exists({
        orgId: organization.id,
        userId: existingUser._id,
      }).session(invitationSession)) {
        throw new HttpError(409, "This user is already a member.");
      }
      await OrganizationInvitationModel.updateMany(
        { orgId: organization.id, email, status: "pending" },
        { $set: { status: "revoked" } },
        { session: invitationSession },
      );
      await OrganizationInvitationModel.create([{
        orgId: organization.id,
        email,
        role,
        tokenHash: invitationTokenHash,
        invitedBy: user.id,
        expiresAt,
      }], { session: invitationSession });
    });
  } finally {
    await invitationSession.endSession();
  }
  const invitation = await OrganizationInvitationModel.findOne({ tokenHash: invitationTokenHash }).select("+tokenHash");
  if (!invitation) throw new Error("Invitation could not be created.");
  await recordAuditLog(request, {
    action: "member.invited",
    resource: "invitation",
    resourceId: invitation.id,
    after: { email, role, expiresAt: invitation.expiresAt },
  });
  const acceptUrl = `${request.whiteLabel?.origin ?? env.clientUrl}/invite/${token}`;
  const emailBrand = await emailBrandForRequest(request);
  const emailContent = organizationInvitationEmail({
    brand: emailBrand,
    organizationName: organization.name,
    inviterName: user.name,
    inviterEmail: user.email,
    recipientName: existingUser?.name,
    role,
    acceptUrl,
    expiresAt: invitation.expiresAt,
  });
  let emailDeliveryStatus: "sent" | "preview" | "failed" = "failed";
  try {
    const delivery = await sendTransactionalEmail({
      userId: existingUser?.id,
      to: email,
      kind: "invitation",
      fromName: emailBrand?.productName,
      fromAddress: emailBrand?.fromAddress,
      resendApiKey: emailBrand?.resendApiKey,
      requireVerifiedFromAddress: Boolean(emailBrand),
      replyTo: emailBrand?.replyTo,
      ...emailContent,
    });
    emailDeliveryStatus = delivery.status;
  } catch (error) {
    console.error("Invitation email delivery failed.", error);
  }
  response.status(201).json({
    emailDeliveryStatus,
    invitation: {
      ...invitation.toObject(),
      tokenHash: undefined,
      acceptUrl,
    },
  });
}

async function resolvePendingInvitation(whiteLabel: WhiteLabelRequestContext | null, token: string) {
  if (!token) throw new HttpError(410, "This invitation is invalid or expired.");
  const invitation = await OrganizationInvitationModel.findOne({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    status: "pending",
  }).select("+tokenHash");
  if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(410, "This invitation is invalid or expired.");
  }
  const invitedOrganization = await OrganizationModel.findById(invitation.orgId);
  if (!invitedOrganization || invitedOrganization.lifecycleStatus !== "active") {
    throw new HttpError(410, "The invited organization is no longer active.");
  }
  if (whiteLabel && (
    String(invitedOrganization.whiteLabelAccountId ?? "") !== whiteLabel.accountId
    || String(invitedOrganization.whiteLabelBrandId ?? "") !== whiteLabel.brandId
  )) {
    throw new HttpError(403, "This invitation belongs to another branded workspace.");
  }
  if (!whiteLabel && invitedOrganization.whiteLabelAccountId) {
    throw new HttpError(403, "Open this invitation from its branded domain.");
  }
  return { invitation, invitedOrganization };
}

async function admitInvitedMember(
  admissionSession: ClientSession,
  input: {
    invitation: { _id: unknown; orgId: unknown; role: OrganizationRole };
    invitedOrganization: { whiteLabelAccountId?: unknown };
    userId: string;
    acceptedAt: Date;
  },
) {
  const existingMembership = await OrganizationMemberModel.exists({
    orgId: input.invitation.orgId,
    userId: input.userId,
  }).session(admissionSession);
  if (!existingMembership && input.invitedOrganization.whiteLabelAccountId) {
    const subscription = await WhiteLabelSubscriptionModel.findOneAndUpdate(
      {
        orgId: input.invitation.orgId,
        accountId: input.invitedOrganization.whiteLabelAccountId,
        status: { $in: ["trialing", "active"] },
      },
      { $inc: { capacityRevision: 1 } },
      { new: true, session: admissionSession },
    ).select("+capacityRevision limitsSnapshot featuresSnapshot");
    if (!subscription) throw new HttpError(402, "An active customer subscription is required to join this workspace.");
    const features = (subscription.featuresSnapshot ?? {}) as Record<string, unknown>;
    if (features.teamAccess !== true) throw new HttpError(403, "Team access is not included in this customer plan.");
    const memberLimit = Math.max(0, Number((subscription.limitsSnapshot as Record<string, unknown>)?.members ?? 0));
    const memberCount = await OrganizationMemberModel.countDocuments({ orgId: input.invitation.orgId })
      .session(admissionSession);
    if (memberCount >= memberLimit) {
      throw new HttpError(409, `Team member limit of ${memberLimit} reached for this plan.`);
    }
  }
  await OrganizationMemberModel.findOneAndUpdate(
    { orgId: input.invitation.orgId, userId: input.userId },
    { $set: { role: input.invitation.role, joinedAt: input.acceptedAt } },
    { new: true, upsert: true, runValidators: true, session: admissionSession },
  );
  const accepted = await OrganizationInvitationModel.updateOne(
    { _id: input.invitation._id, status: "pending", expiresAt: { $gt: input.acceptedAt } },
    { $set: { status: "accepted", acceptedAt: input.acceptedAt } },
    { session: admissionSession },
  );
  if (accepted.matchedCount !== 1) throw new HttpError(410, "This invitation is invalid or expired.");
}

export async function previewInvitation(request: Request, response: Response) {
  const whiteLabel = await resolveWhiteLabelRequestContext(request);
  const token = typeof request.query.token === "string" ? request.query.token : "";
  const { invitation, invitedOrganization } = await resolvePendingInvitation(whiteLabel, token);
  const existingUser = await UserModel.findOne({ email: invitation.email })
    .select("+passwordHash +googleSubject")
    .lean();
  const hasAccount = Boolean(existingUser && (existingUser.passwordHash || existingUser.googleSubject));
  response.json({
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    organizationName: invitedOrganization.name,
    hasAccount,
    whiteLabel: Boolean(whiteLabel),
    productName: whiteLabel?.productName ?? "Vozon",
  });
}

export async function completeInvitation(request: Request, response: Response) {
  const whiteLabel = await resolveWhiteLabelRequestContext(request);
  const token = typeof request.body.token === "string" ? request.body.token : "";
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const password = typeof request.body.password === "string" ? request.body.password : "";
  if (name.length < 2 || name.length > 80) {
    throw new HttpError(400, "Name must be between 2 and 80 characters.");
  }
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, "Password must be between 8 and 128 characters.");
  }
  const { invitation, invitedOrganization } = await resolvePendingInvitation(whiteLabel, token);
  const existingUser = await UserModel.findOne({ email: invitation.email })
    .select("+passwordHash +googleSubject");
  if (existingUser && (existingUser.passwordHash || existingUser.googleSubject)) {
    throw new HttpError(409, "An account already exists for this email. Sign in to accept the invitation.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const acceptedAt = new Date();
  let completedUserId = existingUser?.id ?? "";
  const admissionSession = await startSession();
  try {
    await admissionSession.withTransaction(async () => {
      let user = existingUser;
      if (!user) {
        const [created] = await UserModel.create([{
          name,
          email: invitation.email,
          emailVerified: true,
          passwordHash,
          termsAcceptedAt: acceptedAt,
        }], { session: admissionSession });
        user = created;
      } else {
        user.name = name;
        user.passwordHash = passwordHash;
        user.emailVerified = true;
        user.passwordResetTokenHash = "";
        user.passwordResetExpires = undefined;
        user.termsAcceptedAt = user.termsAcceptedAt ?? acceptedAt;
        await user.save({ session: admissionSession });
      }
      completedUserId = user.id;
      await admitInvitedMember(admissionSession, {
        invitation,
        invitedOrganization,
        userId: user.id,
        acceptedAt,
      });
    });
  } finally {
    await admissionSession.endSession();
  }

  const user = await UserModel.findById(completedUserId);
  if (!user) throw new Error("Invited user could not be loaded after invitation completion.");
  const tokenId = randomUUID();
  await AuthSessionModel.create({
    userId: user.id,
    orgId: invitedOrganization.id,
    tokenId,
    device: String(request.headers["user-agent"] ?? "Unknown device").slice(0, 500),
    ip: request.ip || request.socket.remoteAddress || "",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  const authToken = signAuthToken(user.id, invitedOrganization.id, tokenId);
  setAuthCookie(response, authToken);
  setRefreshCookie(response, tokenId);

  const publicUser = toPublicUser(user);
  const authenticatedRequest = request as AuthenticatedRequest;
  authenticatedRequest.user = publicUser;
  await recordAuditLog(authenticatedRequest, {
    orgId: invitedOrganization.id,
    action: "member.invitation_accepted",
    resource: "invitation",
    resourceId: invitation.id,
    after: { email: invitation.email, role: invitation.role, acceptedAt },
  });

  const wlSubscription = invitedOrganization.whiteLabelAccountId
    ? await WhiteLabelSubscriptionModel.findOne({
        orgId: invitedOrganization._id,
        accountId: invitedOrganization.whiteLabelAccountId,
      }).select("featuresSnapshot planNameSnapshot").lean()
    : null;
  response.status(201).json({
    user: publicUser,
    organization: {
      ...invitedOrganization.toObject(),
      id: invitedOrganization.id,
      role: invitation.role,
      ...(wlSubscription?.featuresSnapshot ? { whiteLabelFeatures: wlSubscription.featuresSnapshot } : {}),
      ...(wlSubscription?.planNameSnapshot ? { whiteLabelPlanName: wlSubscription.planNameSnapshot } : {}),
    },
    token: authToken,
  });
}

export async function acceptInvitation(request: AuthenticatedRequest, response: Response) {
  const { user } = context(request);
  const token = typeof request.body.token === "string" ? request.body.token : "";
  const { invitation, invitedOrganization } = await resolvePendingInvitation(request.whiteLabel ?? null, token);
  if (invitation.email !== user.email) {
    throw new HttpError(403, "Sign in with the email address that received this invitation.");
  }
  const acceptedAt = new Date();
  const admissionSession = await startSession();
  try {
    await admissionSession.withTransaction(async () => {
      await admitInvitedMember(admissionSession, {
        invitation,
        invitedOrganization,
        userId: user.id,
        acceptedAt,
      });
    });
  } finally {
    await admissionSession.endSession();
  }
  invitation.status = "accepted";
  invitation.acceptedAt = acceptedAt;
  await recordAuditLog(request, {
    orgId: String(invitation.orgId),
    action: "member.invitation_accepted",
    resource: "invitation",
    resourceId: invitation.id,
    after: { email: invitation.email, role: invitation.role, acceptedAt: invitation.acceptedAt },
  });
  if (request.sessionId) {
    await AuthSessionModel.updateOne({ tokenId: request.sessionId }, { orgId: invitation.orgId, lastSeenAt: new Date() });
  }
  setAuthCookie(response, signAuthToken(user.id, String(invitation.orgId), request.sessionId));
  response.status(204).end();
}

export async function updateMember(request: AuthenticatedRequest, response: Response) {
  const { organization } = context(request);
  const role = inviteRole(request.body.role);
  const member = await OrganizationMemberModel.findOne({
    _id: request.params.memberId,
    orgId: organization.id,
  });
  if (!member) throw new HttpError(404, "Organization member not found.");
  if (member.role === "owner") throw new HttpError(409, "The organization owner role cannot be changed.");
  const before = { role: member.role, userId: String(member.userId) };
  member.role = role;
  await member.save();
  await recordAuditLog(request, {
    action: "member.role_updated",
    resource: "member",
    resourceId: member.id,
    before,
    after: { role: member.role, userId: String(member.userId) },
  });
  response.json({ member });
}

export async function removeMember(request: AuthenticatedRequest, response: Response) {
  const { organization } = context(request);
  const member = await OrganizationMemberModel.findOne({
    _id: request.params.memberId,
    orgId: organization.id,
  });
  if (!member) throw new HttpError(404, "Organization member not found.");
  if (member.role === "owner") throw new HttpError(409, "The organization owner cannot be removed.");
  const before = { role: member.role, userId: String(member.userId) };
  await member.deleteOne();
  await recordAuditLog(request, {
    action: "member.removed",
    resource: "member",
    resourceId: member.id,
    before,
  });
  response.status(204).end();
}

export async function listAuditLog(request: AuthenticatedRequest, response: Response) {
  const { organization } = context(request);
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 25));
  const filter: Record<string, unknown> = { orgId: organization.id };
  const resource = typeof request.query.resource === "string" ? request.query.resource.trim() : "";
  const action = typeof request.query.action === "string" ? request.query.action.trim() : "";
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  if (resource) filter.resource = resource;
  if (action) filter.action = action;
  if (search) {
    const regex = new RegExp(escapeRegExp(search), "i");
    filter.$or = [
      { action: regex },
      { resource: regex },
      { resourceId: regex },
      { actorEmail: regex },
      { "before.name": regex },
      { "after.name": regex },
      { "before.email": regex },
      { "after.email": regex },
    ];
  }
  const [auditLogs, total] = await Promise.all([
    AuditLogModel.find(filter)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLogModel.countDocuments(filter),
  ]);
  response.json({
    auditLogs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
}

export async function getCurrentOrganizationBrand(request: AuthenticatedRequest, response: Response) {
  const orgId = request.organization?.id;
  if (!orgId) {
    response.json({ brand: null });
    return;
  }
  const brand = await resolveBrandForOrganization(orgId, request.hostname);
  response.json({ brand });
}

export async function getCurrentWhiteLabelRevision(request: AuthenticatedRequest, response: Response) {
  const orgId = request.organization?.id;
  const accountId = request.organization?.whiteLabelAccountId;
  const brandId = request.organization?.whiteLabelBrandId;
  if (!orgId || !accountId || !brandId) throw new HttpError(404, "White-label customer workspace not found.");

  const [organization, subscription, account, brand, domains, wallet] = await Promise.all([
    OrganizationModel.findById(orgId).select("name lifecycleStatus whiteLabelBrandId").lean(),
    WhiteLabelSubscriptionModel.findOne({ orgId, accountId })
      .select("planId planKey planNameSnapshot planVersion status billingMode priceSnapshot usagePricingSnapshot allowancesSnapshot limitsSnapshot featuresSnapshot modelAccessSnapshot currentPeriodStart currentPeriodEnd trialEndsAt")
      .lean(),
    WhiteLabelAccountModel.findById(accountId)
      .select("status billingStatus limits entitlements modelAccess customerOnboarding retailBilling rechargePackages")
      .lean(),
    WhiteLabelBrandModel.findById(brandId)
      .select("status branding support legal")
      .lean(),
    WhiteLabelDomainModel.find({ accountId, brandId })
      .select("kind hostname status")
      .sort({ _id: 1 })
      .lean(),
    CreditWalletModel.findOne({ orgId }).select("balanceCredits lastPaymentAt currency").lean(),
  ]);
  if (!organization || !subscription || !account) throw new HttpError(404, "White-label customer workspace not found.");

  const revision = createHash("sha256")
    .update(JSON.stringify({ organization, subscription, account, brand, domains, wallet }))
    .digest("hex");
  response.setHeader("Cache-Control", "private, no-store");
  response.json({ revision });
}

