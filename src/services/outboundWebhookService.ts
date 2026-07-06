import { createHmac, randomUUID } from "node:crypto";

import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";
import {
  WebhookEndpointModel,
  type OutboundWebhookEvent,
} from "../models/WebhookEndpoint.js";
import { decryptSecret } from "../utils/secretCrypto.js";

const retrySeconds = [60, 300, 1800, 7200, 43200];

type PhoneNumberSource = "recorded" | "room_name" | "missing";

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizePhoneDigits(digits: string, countryContext = "") {
  const contextDigits = countryContext.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (contextDigits.startsWith("91") && digits.length === 11 && digits.startsWith("0")) {
    return `+91${digits.slice(1)}`;
  }
  if (contextDigits.startsWith("91") && digits.length === 10) {
    return `+91${digits}`;
  }
  return digits;
}

function phoneValue(value: unknown, countryContext = "") {
  const text = textValue(value);
  const e164 = text.match(/\+\d[\d\s().-]{5,}\d/);
  if (e164) return `+${e164[0].replace(/\D/g, "")}`;
  const local = text.match(/(?:^|\D)(\d{7,15})(?=\D|$)/)?.[1] ?? "";
  return local ? normalizePhoneDigits(local, countryContext) : "";
}

function formatRoomPhone(digits: string, destinationDigits = "") {
  if (!digits) return "";
  if (destinationDigits.startsWith("91") && digits.length === 11 && digits.startsWith("0")) {
    return `+91${digits.slice(1)}`;
  }
  if (destinationDigits.startsWith("91") && digits.length === 10) {
    return `+91${digits}`;
  }
  return digits.length >= 11 ? `+${digits}` : digits;
}

function inboundRoomNumbers(value: unknown) {
  const roomName = textValue(value);
  const match = /^inbound-(\d{7,15})-(.*)$/.exec(roomName);
  if (!match) return { callerNumber: "", calledNumber: "" };
  const destinationDigits = match[1] ?? "";
  const suffix = match[2] ?? "";
  const callerDigits = [...suffix.matchAll(/\d{7,15}/g)]
    .map((item) => item[0])
    .find((digits) => digits !== destinationDigits) ?? "";
  return {
    callerNumber: formatRoomPhone(callerDigits, destinationDigits),
    calledNumber: formatRoomPhone(destinationDigits),
  };
}

function routeNumberDetails(raw: Record<string, unknown>) {
  const inferred = textValue(raw.direction) === "inbound"
    ? inboundRoomNumbers(raw.livekitRoomName)
    : { callerNumber: "", calledNumber: "" };
  const rawRecordedCalled = textValue(raw.calledNumber);
  const rawRecordedCaller = textValue(raw.callerNumber);
  const calledNumber = phoneValue(rawRecordedCalled, inferred.calledNumber) || inferred.calledNumber;
  const callerNumber = phoneValue(rawRecordedCaller, calledNumber) || inferred.callerNumber;
  return {
    callerNumber,
    calledNumber,
    callerNumberSource: (rawRecordedCaller ? "recorded" : inferred.callerNumber ? "room_name" : "missing") as PhoneNumberSource,
    calledNumberSource: (rawRecordedCalled ? "recorded" : inferred.calledNumber ? "room_name" : "missing") as PhoneNumberSource,
  };
}

function webhookData(data: unknown) {
  const raw = objectValue(data);
  if (!raw || (!("callerNumber" in raw) && !("calledNumber" in raw) && !("livekitRoomName" in raw))) {
    return data;
  }

  const direction = textValue(raw.direction);
  const route = routeNumberDetails(raw);
  const voip = objectValue(raw.voip);
  return {
    ...raw,
    callerNumber: route.callerNumber,
    calledNumber: route.calledNumber,
    callerNumberSource: route.callerNumberSource,
    calledNumberSource: route.calledNumberSource,
    from_number: route.callerNumber,
    to_number: route.calledNumber,
    voip: {
      ...voip,
      from: route.callerNumber,
      to: route.calledNumber,
      direction,
    },
  };
}

function bodyFor(eventId: string, event: OutboundWebhookEvent, data: unknown) {
  return {
    id: eventId,
    event,
    createdAt: new Date().toISOString(),
    data: webhookData(data),
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
