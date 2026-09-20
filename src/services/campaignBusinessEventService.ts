import { createHash } from "node:crypto";

import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignBusinessEventModel } from "../models/CampaignBusinessEvent.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";

type BusinessEventType = "appointment" | "booking" | "payment" | "revenue" | "lead" | "other";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsedResponse(value: string) {
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function firstText(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstAmount(data: Record<string, unknown>, args: Record<string, unknown>) {
  for (const source of [data, objectValue(data.data), objectValue(data.result), args]) {
    for (const key of ["amount", "total", "revenue", "value", "paidAmount", "paid_amount"]) {
      const amount = Number(source[key]);
      if (Number.isFinite(amount) && amount >= 0) return amount;
    }
  }
  return 0;
}

function eventTypeForTool(toolName: string): BusinessEventType | null {
  const name = toolName.toLowerCase();
  if (/payment|checkout|invoice|transaction|collect.*pay|charge/.test(name)) return "payment";
  if (/revenue|sale|order/.test(name)) return "revenue";
  if (/appointment|schedule.*visit|book.*appointment/.test(name)) return "appointment";
  if (/booking|reservation|create_book/.test(name)) return "booking";
  if (/create.*lead|qualif.*lead|convert.*lead/.test(name)) return "lead";
  return null;
}

function responseSucceeded(data: Record<string, unknown>, responseText: string) {
  const status = firstText(data, ["status", "payment_status", "booking_status"]).toLowerCase();
  if (
    [data.success, data.ok, data.completed, data.booked, data.verified].includes(false) ||
    ["failed", "failure", "declined", "rejected", "cancelled", "canceled"].includes(status) ||
    /\b(not confirmed|not booked|payment failed|booking failed|declined|rejected)\b/i.test(responseText)
  ) return false;
  const nested = objectValue(data.data);
  if ([data.success, data.ok, data.completed, data.booked, data.verified, nested.success, nested.ok].includes(true)) {
    return true;
  }
  if (["success", "succeeded", "completed", "confirmed", "paid", "verified", "booked"].includes(status)) {
    return true;
  }
  return /\b(success|succeeded|completed|confirmed|booked|payment received|paid)\b/i.test(responseText);
}

function externalIdFrom(data: Record<string, unknown>) {
  const nested = objectValue(data.data);
  const result = objectValue(data.result);
  return firstText(data, ["externalId", "external_id", "transactionId", "transaction_id", "paymentId", "payment_id", "bookingId", "booking_id", "appointmentId", "appointment_id", "id"]) ||
    firstText(nested, ["transactionId", "paymentId", "bookingId", "appointmentId", "id"]) ||
    firstText(result, ["transactionId", "paymentId", "bookingId", "appointmentId", "id"]);
}

export async function recordVerifiedToolBusinessEvent(input: {
  roomName: string;
  toolName: string;
  args: Record<string, unknown>;
  responseText: string;
}) {
  const type = eventTypeForTool(input.toolName);
  if (!type) return null;
  const data = parsedResponse(input.responseText);
  if (!responseSucceeded(data, input.responseText)) return null;
  const externalId = externalIdFrom(data);
  // A payment is only called verified when the payment provider returned a durable reference.
  if ((type === "payment" || type === "revenue") && !externalId) return null;

  const call = await CallDetailRecordModel.findOne({ livekitRoomName: input.roomName })
    .select("_id ownerId campaignId campaignLeadId")
    .lean();
  if (!call?.campaignId || !call.campaignLeadId) return null;
  const amount = firstAmount(data, input.args);
  const currency = (firstText(data, ["currency", "currencyCode", "currency_code"]) ||
    firstText(input.args, ["currency", "currencyCode"]) || "INR").toUpperCase().slice(0, 10);
  const rawKey = [call._id, type, input.toolName, externalId || JSON.stringify(input.args)].join(":");
  const dedupeKey = `tool:${createHash("sha256").update(rawKey).digest("hex")}`;
  const occurredAt = new Date();
  const event = await CampaignBusinessEventModel.findOneAndUpdate(
    { ownerId: call.ownerId, dedupeKey },
    {
      $setOnInsert: {
        ownerId: call.ownerId,
        campaignId: call.campaignId,
        campaignLeadId: call.campaignLeadId,
        callId: call._id,
        type,
        status: "verified",
        source: "tool",
        label: input.toolName,
        amount,
        currency,
        externalId,
        dedupeKey,
        evidence: {
          toolName: input.toolName,
          response: input.responseText.slice(0, 2000),
        },
        occurredAt,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  await CampaignLeadModel.updateOne(
    { _id: call.campaignLeadId, ownerId: call.ownerId },
    {
      $set: {
        conversionType: type,
        conversionStatus: "verified",
        conversionExternalId: externalId,
        conversionVerifiedAt: occurredAt,
        ...(amount > 0 ? { attributedRevenue: amount, revenueCurrency: currency } : {}),
      },
    },
  );
  return event;
}

export async function recordHumanBusinessEvent(input: {
  ownerId: string;
  userId: string;
  campaignId: unknown;
  campaignLeadId: unknown;
  type: BusinessEventType;
  status: "pending" | "verified" | "rejected" | "refunded";
  amount: number;
  currency: string;
  externalId: string;
  note: string;
}) {
  const occurredAt = new Date();
  const rawKey = [input.campaignLeadId, input.type, input.status, input.externalId || occurredAt.toISOString()].join(":");
  const dedupeKey = `human:${createHash("sha256").update(rawKey).digest("hex")}`;
  const event = await CampaignBusinessEventModel.create({
    ownerId: input.ownerId,
    campaignId: input.campaignId,
    campaignLeadId: input.campaignLeadId,
    type: input.type,
    status: input.status,
    source: "human",
    label: input.note,
    amount: input.amount,
    currency: input.currency,
    externalId: input.externalId,
    dedupeKey,
    evidence: { note: input.note },
    occurredAt,
    createdBy: input.userId,
  });
  await CampaignLeadModel.updateOne(
    { _id: input.campaignLeadId, campaignId: input.campaignId, ownerId: input.ownerId },
    {
      $set: {
        conversionType: input.type,
        conversionStatus: input.status,
        conversionExternalId: input.externalId,
        attributedRevenue: input.amount,
        revenueCurrency: input.currency,
        conversionVerifiedAt: input.status === "verified" ? occurredAt : null,
      },
    },
  );
  return event;
}
