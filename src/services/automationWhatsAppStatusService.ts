import { createHmac, timingSafeEqual } from "node:crypto";
import { AutomationWhatsAppStatusModel } from "../models/Automation.js";

export function verifyWhatsAppSignature(rawBody: Buffer, signature: string, appSecret: string) {
  if (!appSecret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.from(signature.slice(7), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function recordAutomationWhatsAppStatuses(body: unknown) {
  if (!body || typeof body !== "object" || (body as { object?: unknown }).object !== "whatsapp_business_account") return 0;
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return 0;
  let recorded = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const statuses = change?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const item of statuses) {
        const messageId = String(item?.id ?? "").slice(0, 200);
        const status = String(item?.status ?? "");
        if (!messageId || !["sent", "delivered", "read", "failed"].includes(status)) continue;
        const rawTimestamp = Number(item?.timestamp);
        const providerTimestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? new Date(rawTimestamp * 1000) : null;
        const error = Array.isArray(item?.errors) ? String(item.errors[0]?.title ?? item.errors[0]?.message ?? "") : "";
        await AutomationWhatsAppStatusModel.updateOne(
          { messageId },
          { $setOnInsert: { messageId, status: "sent", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } },
          { upsert: true },
        );
        const allowedPrevious = status === "sent" ? ["sent"] : status === "delivered" ? ["sent", "delivered"]
          : status === "read" ? ["sent", "delivered", "read"] : ["sent", "failed"];
        const timestampGuard = providerTimestamp
          ? { $or: [{ providerTimestamp: null }, { providerTimestamp: { $lte: providerTimestamp } }] }
          : {};
        await AutomationWhatsAppStatusModel.updateOne(
          { messageId, status: { $in: allowedPrevious }, ...timestampGuard },
          { $set: { status, error: error.slice(0, 500), providerTimestamp } },
        );
        recorded += 1;
      }
    }
  }
  return recorded;
}
