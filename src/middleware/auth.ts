import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";

import { UserModel, toPublicUser, type PublicUser } from "../models/User.js";
import { HttpError } from "../utils/httpError.js";
import { verifyAuthToken } from "../utils/jwt.js";
import { env } from "../config/env.js";
import { resolvePlatformOrganization, resolveWhiteLabelOrganization, roleAllowed } from "../services/organizationService.js";
import type { OrganizationRole } from "../models/OrganizationMember.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { OrganizationModel } from "../models/Organization.js";
import { ApiKeyModel, type ApiKeyScope } from "../models/ApiKey.js";
import { AuthSessionModel } from "../models/AuthSession.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import {
  resolveWhiteLabelRequestContext,
  type WhiteLabelRequestContext,
} from "../services/whiteLabelService.js";

const authUserProjection = "_id name email emailVerified twoFactorEnabled lastLoginAt createdAt +platformRole";
const authOrganizationProjection = "_id name slug lifecycleStatus whiteLabelAccountId whiteLabelBrandId whiteLabelOwnerAccountId";
const authMembershipProjection = "_id role";
const authSessionProjection = "_id tokenId lastSeenAt";

export type AuthenticatedRequest = Request & {
  user?: PublicUser;
  organization?: {
    id: string;
    name: string;
    slug: string;
    role: OrganizationRole;
    whiteLabelAccountId?: string;
    whiteLabelBrandId?: string;
    whiteLabelOwnerAccountId?: string;
  };
  apiKey?: { id: string; scopes: ApiKeyScope[] };
  sessionId?: string;
  platformRole?: "user" | "support" | "super_admin";
  whiteLabel?: WhiteLabelRequestContext | null;
};

function effectivePlatformRole(user: PublicUser) {
  if (user.platformRole === "super_admin" || user.platformRole === "support") return user.platformRole;
  return env.platformAdminEmails.includes(user.email.toLowerCase()) ? "super_admin" : "user";
}

export function organizationMatchesRequestDomain(
  organization: { whiteLabelAccountId?: unknown; whiteLabelBrandId?: unknown },
  whiteLabel: WhiteLabelRequestContext | null,
) {
  const accountId = organization.whiteLabelAccountId ? String(organization.whiteLabelAccountId) : "";
  const brandId = organization.whiteLabelBrandId ? String(organization.whiteLabelBrandId) : "";
  return whiteLabel
    ? whiteLabel.accountId === accountId && whiteLabel.brandId === brandId
    : !accountId;
}

async function assertOrganizationActive(organization: {
  lifecycleStatus?: string;
  whiteLabelAccountId?: unknown;
  whiteLabelBrandId?: unknown;
}, whiteLabel: WhiteLabelRequestContext | null) {
  if (organization.lifecycleStatus === "suspended") {
    throw new HttpError(403, "This organization is suspended. Contact your account administrator.");
  }
  if (organization.lifecycleStatus === "archived") {
    throw new HttpError(403, "This organization is archived.");
  }
  const accountId = organization.whiteLabelAccountId ? String(organization.whiteLabelAccountId) : "";
  if (!organizationMatchesRequestDomain(organization, whiteLabel)) {
    throw new HttpError(
      403,
      whiteLabel
        ? "This organization is not available on the current branded domain."
        : "Open this organization from its branded domain.",
    );
  }
  if (accountId) {
    const activeAccount = await WhiteLabelAccountModel.exists({
      _id: accountId,
      status: "active",
      billingStatus: { $in: ["trialing", "active"] },
    });
    if (!activeAccount) throw new HttpError(403, "This white-label service is not active.");
  }
}

function requestOrganization(
  organization: {
    id?: string;
    _id?: unknown;
    name: string;
    slug: string;
    whiteLabelAccountId?: unknown;
    whiteLabelBrandId?: unknown;
    whiteLabelOwnerAccountId?: unknown;
  },
  role: OrganizationRole,
) {
  return {
    id: organization.id ?? String(organization._id),
    name: organization.name,
    slug: organization.slug,
    role,
    ...(organization.whiteLabelAccountId ? { whiteLabelAccountId: String(organization.whiteLabelAccountId) } : {}),
    ...(organization.whiteLabelBrandId ? { whiteLabelBrandId: String(organization.whiteLabelBrandId) } : {}),
    ...(organization.whiteLabelOwnerAccountId ? { whiteLabelOwnerAccountId: String(organization.whiteLabelOwnerAccountId) } : {}),
  };
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

export async function requireAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  try {
    const whiteLabel = await resolveWhiteLabelRequestContext(request);
    request.whiteLabel = whiteLabel;
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const apiKeyValue = String(request.headers["x-api-key"] ?? (bearer.startsWith("avp_") ? bearer : ""));
    if (apiKeyValue) {
      const apiKey = await ApiKeyModel.findOne({
        keyHash: createHash("sha256").update(apiKeyValue).digest("hex"),
        revokedAt: { $exists: false },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      }).select("_id orgId createdBy scopes");
      if (!apiKey) throw new HttpError(401, "Invalid or expired API key.");
      const [user, organization, membership] = await Promise.all([
        UserModel.findById(apiKey.createdBy).select(authUserProjection),
        OrganizationModel.findById(apiKey.orgId).select(authOrganizationProjection),
        OrganizationMemberModel.findOne({ orgId: apiKey.orgId, userId: apiKey.createdBy })
          .select(authMembershipProjection),
      ]);
      if (!user || !organization || !membership) throw new HttpError(401, "API key owner is no longer active.");
      await assertOrganizationActive(organization, whiteLabel);
      request.user = toPublicUser(user);
      request.platformRole = effectivePlatformRole(request.user);
      request.organization = requestOrganization(organization, membership.role);
      request.apiKey = { id: apiKey.id, scopes: apiKey.scopes as ApiKeyScope[] };
      void ApiKeyModel.updateOne({ _id: apiKey._id }, { lastUsedAt: new Date() });
      next();
      return;
    }

    const token = bearer || cookieValue(request, env.authCookieName);

    if (!token) {
      throw new HttpError(401, "Authentication required.");
    }

    const payload = verifyAuthToken(token);
    const requestedOrgId = payload.orgId;
    const [user, session, requestedMembership, requestedOrganization] = await Promise.all([
      UserModel.findById(payload.sub).select(authUserProjection),
      payload.sid
        ? AuthSessionModel.findOne({
            tokenId: payload.sid,
            userId: payload.sub,
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() },
          }).select(authSessionProjection)
        : Promise.resolve(null),
      requestedOrgId
        ? OrganizationMemberModel.findOne({ userId: payload.sub, orgId: requestedOrgId })
          .select(authMembershipProjection)
        : Promise.resolve(null),
      requestedOrgId
        ? OrganizationModel.findById(requestedOrgId).select(authOrganizationProjection)
        : Promise.resolve(null),
    ]);

    if (!user) {
      throw new HttpError(401, "Authentication required.");
    }
    if (payload.sid) {
      if (!session) throw new HttpError(401, "This session has expired or was revoked.");
      request.sessionId = session.tokenId;
      const lastSeenAt = session.lastSeenAt?.getTime() ?? 0;
      if (Date.now() - lastSeenAt > 5 * 60 * 1000) {
        void AuthSessionModel.updateOne(
          { _id: session._id, lastSeenAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
          { lastSeenAt: new Date() },
        );
      }
    }

    const fallbackOrganization = requestedMembership && requestedOrganization
      ? null
      : whiteLabel
        ? await resolveWhiteLabelOrganization(user, {
            accountId: whiteLabel.accountId,
            brandId: whiteLabel.brandId,
            requestedOrgId,
          })
        : await resolvePlatformOrganization(user, requestedOrgId);
    const resolvedOrganization = requestedMembership && requestedOrganization
      ? { organization: requestedOrganization, membership: requestedMembership }
      : fallbackOrganization;
    if (!resolvedOrganization) throw new HttpError(403, "No organization is available on this domain.");
    const { organization, membership } = resolvedOrganization;
    await assertOrganizationActive(organization, whiteLabel);
    request.user = toPublicUser(user);
    request.platformRole = effectivePlatformRole(request.user);
    request.organization = requestOrganization(organization, membership.role);
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Invalid session."));
  }
}

export function requirePlatformRole(...roles: Array<"support" | "super_admin">) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
    if (!request.user || !request.platformRole || !roles.includes(request.platformRole as "support" | "super_admin")) {
      next(new HttpError(403, "Platform administrator access is required."));
      return;
    }
    if (env.nodeEnv === "production" && (!request.user.emailVerified || !request.user.twoFactorEnabled)) {
      next(new HttpError(403, "Platform administration requires verified email and two-factor authentication."));
      return;
    }
    next();
  };
}

export function requireApiScope(...scopes: ApiKeyScope[]) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
    if (
      request.apiKey &&
      !request.apiKey.scopes.includes("full-access") &&
      !scopes.some((scope) => request.apiKey?.scopes.includes(scope))
    ) {
      next(new HttpError(403, `API key requires one of these scopes: ${scopes.join(", ")}.`));
      return;
    }
    next();
  };
}

export function requireRole(...roles: OrganizationRole[]) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
    if (!request.organization || !roleAllowed(request.organization.role, roles)) {
      next(new HttpError(403, "Your organization role does not allow this action."));
      return;
    }
    next();
  };
}
