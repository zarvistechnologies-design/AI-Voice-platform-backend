import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { HttpError } from "../utils/httpError.js";

export function redactedAuditSnapshot(value: unknown) {
  if (value === undefined) return undefined;
  const snapshot = JSON.parse(JSON.stringify(value));
  function redact(item: unknown): void {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(redact);
      return;
    }
    const record = item as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (/^(?:resendApiKey|keySecret|webhookSecret|customKeySecretEncrypted|customWebhookSecretEncrypted)$/i.test(key)) {
        record[key] = "[REDACTED]";
      } else {
        redact(nested);
      }
    }
  }
  redact(snapshot);
  return snapshot;
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
    before: redactedAuditSnapshot(input.before),
    after: redactedAuditSnapshot(input.after),
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? ""),
  });
}
