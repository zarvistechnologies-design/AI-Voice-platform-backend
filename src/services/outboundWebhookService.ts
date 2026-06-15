import { createHmac, randomUUID } from "node:crypto";

import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";
import {
  WebhookEndpointModel,
  type OutboundWebhookEvent,
} from "../models/WebhookEndpoint.js";
import { decryptSecret } from "../utils/secretCrypto.js";

const retrySeconds = [60, 300, 1800, 7200, 43200];

function bodyFor(eventId: string, event: OutboundWebhookEvent, data: unknown) {
  return {
    id: eventId,
    event,
    createdAt: new Date().toISOString(),
    data,
  };
}

export async function deliverWebhook(deliveryId: string) {
  const delivery = await WebhookDeliveryModel.findById(deliveryId);
  if (!delivery || delivery.status === "delivered" || delivery.status === "failed") return delivery;
  const endpoint = await WebhookEndpointModel.findById(delivery.webhookId).select("+secretEncrypted");
  if (!endpoint || !endpoint.enabled) {
    delivery.status = "failed";
    delivery.errorMessage = "Webhook endpoint is disabled or deleted.";
    await delivery.save();
    return delivery;
  }

  const body = JSON.stringify(delivery.payload);
  const signature = createHmac("sha256", decryptSecret(endpoint.secretEncrypted)).update(body).digest("hex");
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AI-Voice-Platform-Webhooks/1.0",
        "X-AI-Voice-Event": delivery.event,
        "X-AI-Voice-Delivery": delivery.id,
        "X-AI-Voice-Signature": `v1=${signature}`,
      },
      body,
    });
    delivery.responseStatus = response.status;
    delivery.responseBody = (await response.text()).slice(0, 4000);
    if (response.ok) {
      delivery.status = "delivered";
      delivery.deliveredAt = new Date();
      delivery.nextAttemptAt = undefined;
      delivery.errorMessage = "";
    } else {
      delivery.errorMessage = `Webhook returned HTTP ${response.status}.`;
    }
  } catch (error) {
    delivery.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  delivery.attempts += 1;
  delivery.durationMs = Date.now() - startedAt;
  if (delivery.status !== "delivered") {
    const delay = retrySeconds[delivery.attempts - 1];
    delivery.status = delay ? "retrying" : "failed";
    delivery.nextAttemptAt = delay ? new Date(Date.now() + delay * 1000) : undefined;
  }
  await delivery.save();
  return delivery;
}

export async function enqueueWebhookEvent(
  orgId: string,
  event: OutboundWebhookEvent,
  data: unknown,
  sourceId: string,
) {
  const endpoints = await WebhookEndpointModel.find({ orgId, enabled: true, events: event });
  const eventId = `${event}:${sourceId}`;
  const payload = bodyFor(eventId, event, data);
  const deliveries = await Promise.all(
    endpoints.map((endpoint) =>
      WebhookDeliveryModel.findOneAndUpdate(
        { webhookId: endpoint._id, eventId },
        { $setOnInsert: { orgId, webhookId: endpoint._id, eventId, event, payload, status: "pending", nextAttemptAt: new Date() } },
        { new: true, upsert: true, runValidators: true },
      ),
    ),
  );
  await Promise.all(deliveries.map((delivery) => deliverWebhook(delivery.id)));
  return deliveries;
}

export async function sendTestWebhook(webhookId: string, orgId: string) {
  const endpoint = await WebhookEndpointModel.findOne({ _id: webhookId, orgId });
  if (!endpoint) return null;
  const eventId = `test:${randomUUID()}`;
  const payload = bodyFor(eventId, "call.ended", {
    test: true,
    message: "This is a signed test delivery from AI Voice Platform.",
  });
  const delivery = await WebhookDeliveryModel.create({
    orgId,
    webhookId: endpoint._id,
    eventId,
    event: "call.ended",
    payload,
    nextAttemptAt: new Date(),
  });
  return deliverWebhook(delivery.id);
}

export async function processWebhookRetries() {
  const deliveries = await WebhookDeliveryModel.find({
    status: { $in: ["pending", "retrying"] },
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(100);
  await Promise.all(deliveries.map((delivery) => deliverWebhook(delivery.id)));
}
