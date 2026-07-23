import crypto from "node:crypto";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { getVobizCredentials } from "./integrationService.js";

type DigitalBotAdmissionResponse = {
  success?: boolean;
  allowed?: boolean;
  balance?: number;
  ratePerMinute?: number;
  maximumDurationSeconds?: number;
  reason?: string | null;
  message?: string;
};

export type DigitalBotCallAdmission = {
  balance: number;
  ratePerMinute: number;
  maximumDurationSeconds: number;
};

export async function assertDigitalBotVobizCallAllowed(
  ownerId: string,
  providerNumber: string,
  direction: "inbound" | "outbound",
): Promise<DigitalBotCallAdmission> {
  if (!providerNumber) throw new HttpError(409, "The Vobiz caller ID is missing from this call route.");

  const credentials = await getVobizCredentials(ownerId);
  const secret = crypto
    .createHmac("sha256", credentials.authToken)
    .update("digitalbot:vobiz-billing-webhook:v1")
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.digitalBotBillingTimeoutMs);

  let response: globalThis.Response;
  let body: DigitalBotAdmissionResponse = {};
  try {
    const endpoint = `${env.digitalBotBillingUrl.replace(/\/+$/, "")}/admission?secret=${encodeURIComponent(secret)}`;
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerNumber, direction }),
      signal: controller.signal,
    });
    body = await response.json().catch(() => ({})) as DigitalBotAdmissionResponse;
  } catch (error) {
    const timedOut = controller.signal.aborted;
    throw new HttpError(
      503,
      timedOut
        ? "The dashboard balance check timed out. The call was blocked to protect customer credit."
        : `The dashboard balance check failed. The call was blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 402 || body.allowed === false) {
    throw new HttpError(402, "Insufficient DigitalBot dashboard credit. Recharge before starting another call.");
  }
  if (!response.ok || body.allowed !== true) {
    throw new HttpError(503, body.message || "The dashboard could not authorize this Vobiz call.");
  }

  const maximumDurationSeconds = Math.floor(Number(body.maximumDurationSeconds));
  if (!Number.isFinite(maximumDurationSeconds) || maximumDurationSeconds <= 0) {
    throw new HttpError(402, "Insufficient DigitalBot dashboard credit. Recharge before starting another call.");
  }

  return {
    balance: Number(body.balance || 0),
    ratePerMinute: Number(body.ratePerMinute || 6),
    maximumDurationSeconds,
  };
}