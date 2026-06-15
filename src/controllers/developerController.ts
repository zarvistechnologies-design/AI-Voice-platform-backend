import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ApiKeyModel, apiKeyScopes, type ApiKeyScope } from "../models/ApiKey.js";
import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";
import {
  WebhookEndpointModel,
  outboundWebhookEvents,
  type OutboundWebhookEvent,
} from "../models/WebhookEndpoint.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { sendTestWebhook } from "../services/outboundWebhookService.js";
import { HttpError } from "../utils/httpError.js";
import { encryptSecret } from "../utils/secretCrypto.js";

function context(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  if (request.apiKey) throw new HttpError(403, "Use a dashboard session to manage developer credentials.");
  return { userId: request.user.id, orgId: request.organization.id };
}

function webhookUrl(value: unknown) {
  if (typeof value !== "string") throw new HttpError(400, "Enter a webhook URL.");
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw new HttpError(400, "Webhook URL must be a valid HTTP or HTTPS URL.");
  }
}

function events(value: unknown): OutboundWebhookEvent[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Select at least one webhook event.");
  const selected = [...new Set(value.filter((item): item is OutboundWebhookEvent => outboundWebhookEvents.includes(item)))];
  if (!selected.length) throw new HttpError(400, "Select at least one webhook event.");
  return selected;
}

function scopes(value: unknown): ApiKeyScope[] {
  if (!Array.isArray(value)) return ["read"];
  const selected = [...new Set(value.filter((item): item is ApiKeyScope => apiKeyScopes.includes(item)))];
  return selected.length ? selected : ["read"];
}

export async function listWebhooks(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const [webhooks, deliveries] = await Promise.all([
    WebhookEndpointModel.find({ orgId }).sort({ createdAt: -1 }),
    WebhookDeliveryModel.find({ orgId }).sort({ createdAt: -1 }).limit(50),
  ]);
  response.json({ webhooks, deliveries, eventCatalog: outboundWebhookEvents });
}

export async function createWebhook(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const webhook = await WebhookEndpointModel.create({
    orgId,
    name: typeof request.body.name === "string" ? request.body.name.trim() || "Webhook" : "Webhook",
    url: webhookUrl(request.body.url),
    events: events(request.body.events),
    enabled: request.body.enabled !== false,
    secretEncrypted: encryptSecret(secret),
  });
  await recordAuditLog(request, {
    action: "webhook.created",
    resource: "webhook",
    resourceId: webhook.id,
    after: { name: webhook.name, url: webhook.url, events: webhook.events, enabled: webhook.enabled },
  });
  response.status(201).json({ webhook, secret });
}

export async function updateWebhook(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const webhook = await WebhookEndpointModel.findOne({ _id: request.params.webhookId, orgId });
  if (!webhook) throw new HttpError(404, "Webhook not found.");
  const before = { name: webhook.name, url: webhook.url, events: webhook.events, enabled: webhook.enabled };
  if ("name" in request.body) webhook.name = String(request.body.name).trim() || webhook.name;
  if ("url" in request.body) webhook.url = webhookUrl(request.body.url);
  if ("events" in request.body) webhook.events = events(request.body.events);
  if ("enabled" in request.body) webhook.enabled = Boolean(request.body.enabled);
  await webhook.save();
  await recordAuditLog(request, {
    action: "webhook.updated",
    resource: "webhook",
    resourceId: webhook.id,
    before,
    after: { name: webhook.name, url: webhook.url, events: webhook.events, enabled: webhook.enabled },
  });
  response.json({ webhook });
}

export async function deleteWebhook(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const webhook = await WebhookEndpointModel.findOneAndDelete({ _id: request.params.webhookId, orgId });
  if (!webhook) throw new HttpError(404, "Webhook not found.");
  await WebhookDeliveryModel.deleteMany({ webhookId: webhook._id });
  await recordAuditLog(request, {
    action: "webhook.deleted",
    resource: "webhook",
    resourceId: webhook.id,
    before: { name: webhook.name, url: webhook.url, events: webhook.events, enabled: webhook.enabled },
  });
  response.status(204).end();
}

export async function testWebhook(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const delivery = await sendTestWebhook(request.params.webhookId, orgId);
  if (!delivery) throw new HttpError(404, "Webhook not found.");
  response.json({ delivery });
}

export async function listApiKeys(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  response.json({ apiKeys: await ApiKeyModel.find({ orgId }).sort({ createdAt: -1 }), scopeCatalog: apiKeyScopes });
}

export async function createApiKey(request: AuthenticatedRequest, response: Response) {
  const { orgId, userId } = context(request);
  const rawKey = `avp_${randomBytes(32).toString("base64url")}`;
  const expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt) : undefined;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw new HttpError(400, "API key expiry must be in the future.");
  }
  const apiKey = await ApiKeyModel.create({
    orgId,
    createdBy: userId,
    name: typeof request.body.name === "string" ? request.body.name.trim() || "API key" : "API key",
    prefix: rawKey.slice(0, 12),
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    scopes: scopes(request.body.scopes),
    expiresAt,
  });
  await recordAuditLog(request, {
    action: "api_key.created",
    resource: "api_key",
    resourceId: apiKey.id,
    after: { name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes, expiresAt: apiKey.expiresAt },
  });
  response.status(201).json({ apiKey, key: rawKey });
}

export async function revokeApiKey(request: AuthenticatedRequest, response: Response) {
  const { orgId } = context(request);
  const apiKey = await ApiKeyModel.findOneAndUpdate(
    { _id: request.params.apiKeyId, orgId },
    { revokedAt: new Date() },
    { new: true },
  );
  if (!apiKey) throw new HttpError(404, "API key not found.");
  await recordAuditLog(request, {
    action: "api_key.revoked",
    resource: "api_key",
    resourceId: apiKey.id,
    before: { name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes },
    after: { revokedAt: apiKey.revokedAt },
  });
  response.status(204).end();
}
