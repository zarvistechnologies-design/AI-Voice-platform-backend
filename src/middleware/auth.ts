import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";

import { UserModel, toPublicUser, type PublicUser } from "../models/User.js";
import { HttpError } from "../utils/httpError.js";
import { verifyAuthToken } from "../utils/jwt.js";
import { env } from "../config/env.js";
import { resolveActiveOrganization, roleAllowed } from "../services/organizationService.js";
import type { OrganizationRole } from "../models/OrganizationMember.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { OrganizationModel } from "../models/Organization.js";
import { ApiKeyModel, type ApiKeyScope } from "../models/ApiKey.js";
import { AuthSessionModel } from "../models/AuthSession.js";

export type AuthenticatedRequest = Request & {
  user?: PublicUser;
  organization?: { id: string; name: string; slug: string; role: OrganizationRole };
  apiKey?: { id: string; scopes: ApiKeyScope[] };
  sessionId?: string;
};

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
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const apiKeyValue = String(request.headers["x-api-key"] ?? (bearer.startsWith("avp_") ? bearer : ""));
    if (apiKeyValue) {
      const apiKey = await ApiKeyModel.findOne({
        keyHash: createHash("sha256").update(apiKeyValue).digest("hex"),
        revokedAt: { $exists: false },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      });
      if (!apiKey) throw new HttpError(401, "Invalid or expired API key.");
      const [user, organization, membership] = await Promise.all([
        UserModel.findById(apiKey.createdBy),
        OrganizationModel.findById(apiKey.orgId),
        OrganizationMemberModel.findOne({ orgId: apiKey.orgId, userId: apiKey.createdBy }),
      ]);
      if (!user || !organization || !membership) throw new HttpError(401, "API key owner is no longer active.");
      request.user = toPublicUser(user);
      request.organization = {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: membership.role,
      };
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
    const user = await UserModel.findById(payload.sub);

    if (!user) {
      throw new HttpError(401, "Authentication required.");
    }
    if (payload.sid) {
      const session = await AuthSessionModel.findOne({
        tokenId: payload.sid,
        userId: user._id,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      });
      if (!session) throw new HttpError(401, "This session has expired or was revoked.");
      request.sessionId = session.tokenId;
      void AuthSessionModel.updateOne({ _id: session._id }, { lastSeenAt: new Date() });
    }

    const { organization, membership } = await resolveActiveOrganization(user, payload.orgId);
    request.user = toPublicUser(user);
    request.organization = {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: membership.role,
    };
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Invalid session."));
  }
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
