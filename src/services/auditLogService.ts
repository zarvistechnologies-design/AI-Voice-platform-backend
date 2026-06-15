import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { HttpError } from "../utils/httpError.js";

function compact(value: unknown) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export async function recordAuditLog(
  request: AuthenticatedRequest,
  input: {
    action: string;
    resource: string;
    resourceId?: string;
    before?: unknown;
    after?: unknown;
    orgId?: string;
  },
) {
  if (!request.user) throw new HttpError(401, "Authentication required.");
  const orgId = input.orgId ?? request.organization?.id;
  if (!orgId) throw new HttpError(401, "Organization context required.");
  await AuditLogModel.create({
    orgId,
    userId: request.user.id,
    actorEmail: request.user.email,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? "",
    before: compact(input.before),
    after: compact(input.after),
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? ""),
  });
}
