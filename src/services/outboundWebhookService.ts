import { createHmac, randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";
import {
  WebhookEndpointModel,
  type OutboundWebhookEvent,
} from "../models/WebhookEndpoint.js";
import { decryptSecret } from "../utils/secretCrypto.js";

const retrySeconds = [60, 300, 1800, 7200, 43200];
const webhookDeliveryLeaseMs = 2 * 60_000;
const webhookDeliveryConcurrency = 10;

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
  const now = new Date();
  const deliveryToken = randomUUID();
  const delivery = await WebhookDeliveryModel.findOneAndUpdate(
    {
      _id: deliveryId,
      $or: [
        {
          status: { $in: ["pending", "retrying"] },
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: now } },
          ],
        },
        {
          status: "processing",
          deliveryLeaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: "processing",
        deliveryToken,
        deliveryLeaseUntil: new Date(now.getTime() + webhookDeliveryLeaseMs),
      },
    },
    { new: true },
  ).select("+deliveryToken +deliveryLeaseUntil");
  if (!delivery) return WebhookDeliveryModel.findById(deliveryId);

  const claimFilter = {
    _id: delivery._id,
    status: "processing",
    deliveryToken,
  };
  const endpoint = await WebhookEndpointModel.findById(delivery.webhookId).select("+secretEncrypted");
  if (!endpoint || !endpoint.enabled) {
    return WebhookDeliveryModel.findOneAndUpdate(
      claimFilter,
      {
        $set: {
          status: "failed",
          deliveryToken: "",
          errorMessage: "Webhook endpoint is disabled or deleted.",
        },
        $unset: { deliveryLeaseUntil: "", nextAttemptAt: "" },
      },
      { new: true },
    );
  }

  const body = JSON.stringify(delivery.payload);
  const signature = createHmac("sha256", decryptSecret(endpoint.secretEncrypted)).update(body).digest("hex");
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let delivered = false;
  let responseStatus = 0;
  let responseBody = "";
  let errorMessage = "";
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
    responseStatus = response.status;
    responseBody = (await response.text()).slice(0, 4000);
    if (response.ok) {
      delivered = true;
    } else {
      errorMessage = `Webhook returned HTTP ${response.status}.`;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  const attemptNumber = delivery.attempts + 1;
  const retryDelaySeconds = delivered ? undefined : retrySeconds[attemptNumber - 1];
  const status = delivered ? "delivered" : retryDelaySeconds ? "retrying" : "failed";
  const completedAt = new Date();
  const result = await WebhookDeliveryModel.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        status,
        deliveryToken: "",
        responseStatus,
        responseBody,
        durationMs: Date.now() - startedAt,
        errorMessage,
        ...(delivered ? { deliveredAt: completedAt } : {}),
        ...(retryDelaySeconds
          ? { nextAttemptAt: new Date(completedAt.getTime() + retryDelaySeconds * 1000) }
          : {}),
      },
      $inc: { attempts: 1 },
      $unset: {
        deliveryLeaseUntil: "",
        ...(!retryDelaySeconds ? { nextAttemptAt: "" } : {}),
      },
    },
    { new: true },
  );
  return result ?? WebhookDeliveryModel.findById(deliveryId);
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

/** Persist a terminal webhook payload without making it deliverable yet. The
 * call finalizer activates these rows in the same MongoDB transaction as its
 * revision CAS, so stale payloads can never escape a lost claim. */
export async function stageWebhookEvent(
  orgId: string,
  event: OutboundWebhookEvent,
  data: unknown,
  sourceId: string,
) {
  const endpoints = await WebhookEndpointModel.find({ orgId, enabled: true, events: event });
  const eventId = `${event}:${sourceId}`;
  const payload = bodyFor(eventId, event, data);
  return Promise.all(endpoints.map(async (endpoint) => {
    const staged = await WebhookDeliveryModel.findOneAndUpdate(
      { webhookId: endpoint._id, eventId, status: "staged" },
      { $set: { payload, event, orgId } },
      { new: true, runValidators: true },
    );
    if (staged) return staged;
    try {
      return await WebhookDeliveryModel.findOneAndUpdate(
        { webhookId: endpoint._id, eventId },
        {
          $setOnInsert: {
            orgId,
            webhookId: endpoint._id,
            eventId,
            event,
            payload,
            status: "staged",
          },
        },
        { new: true, upsert: true, runValidators: true },
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
      const winner = await WebhookDeliveryModel.findOne({ webhookId: endpoint._id, eventId });
      if (!winner) throw error;
      return winner;
    }
  }));
}

export async function activateStagedWebhookEvents(
  deliveryIds: string[],
  options: { session?: ClientSession } = {},
) {
  if (!deliveryIds.length) return;
  await WebhookDeliveryModel.updateMany(
    { _id: { $in: deliveryIds }, status: "staged" },
    { $set: { status: "pending", nextAttemptAt: new Date() } },
    options.session ? { session: options.session } : {},
  );
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
  const now = new Date();
  const deliveries = await WebhookDeliveryModel.find({
    $or: [
      {
        status: { $in: ["pending", "retrying"] },
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: now } },
        ],
      },
      {
        status: "processing",
        deliveryLeaseUntil: { $lte: now },
      },
    ],
  })
    .select("_id")
    .sort({ nextAttemptAt: 1, deliveryLeaseUntil: 1 })
    .limit(100)
    .lean();
  for (let index = 0; index < deliveries.length; index += webhookDeliveryConcurrency) {
    await Promise.allSettled(
      deliveries
        .slice(index, index + webhookDeliveryConcurrency)
        .map((delivery) => deliverWebhook(String(delivery._id))),
    );
  }
}
