import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { AuthSessionModel } from "../models/AuthSession.js";
import { OrganizationModel } from "../models/Organization.js";
import { OrganizationInvitationModel } from "../models/OrganizationInvitation.js";
import { OrganizationMemberModel, type OrganizationRole } from "../models/OrganizationMember.js";
import { UserModel } from "../models/User.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { createOrganization } from "../services/organizationService.js";
import { setAuthCookie } from "../utils/authCookie.js";
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
    .populate("orgId")
    .sort({ createdAt: 1 });
  response.json({
    activeOrganizationId: organization.id,
    organizations: memberships.map((membership) => ({
      ...(membership.orgId as unknown as { toObject(): Record<string, unknown> }).toObject(),
      role: membership.role,
    })),
  });
}

export async function createOrganizationWorkspace(request: AuthenticatedRequest, response: Response) {
  const { user } = context(request);
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
  if (existingUser && (await OrganizationMemberModel.exists({ orgId: organization.id, userId: existingUser._id }))) {
    throw new HttpError(409, "This user is already a member.");
  }
  await OrganizationInvitationModel.updateMany(
    { orgId: organization.id, email, status: "pending" },
    { status: "revoked" },
  );
  const token = randomBytes(32).toString("hex");
  const invitation = await OrganizationInvitationModel.create({
    orgId: organization.id,
    email,
    role,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    invitedBy: user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  await recordAuditLog(request, {
    action: "member.invited",
    resource: "invitation",
    resourceId: invitation.id,
    after: { email, role, expiresAt: invitation.expiresAt },
  });
  response.status(201).json({
    invitation: {
      ...invitation.toObject(),
      tokenHash: undefined,
      acceptUrl: `${env.clientUrl}/invite/${token}`,
    },
  });
}

export async function acceptInvitation(request: AuthenticatedRequest, response: Response) {
  const { user } = context(request);
  const token = typeof request.body.token === "string" ? request.body.token : "";
  const invitation = await OrganizationInvitationModel.findOne({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    status: "pending",
  }).select("+tokenHash");
  if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(410, "This invitation is invalid or expired.");
  }
  if (invitation.email !== user.email) {
    throw new HttpError(403, "Sign in with the email address that received this invitation.");
  }
  await OrganizationMemberModel.findOneAndUpdate(
    { orgId: invitation.orgId, userId: user.id },
    { $set: { role: invitation.role, joinedAt: new Date() } },
    { new: true, upsert: true, runValidators: true },
  );
  invitation.status = "accepted";
  invitation.acceptedAt = new Date();
  await invitation.save();
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
