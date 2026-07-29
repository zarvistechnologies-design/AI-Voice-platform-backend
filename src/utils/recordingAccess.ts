import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";

function signaturePayload(callId: string, expires: number) {
  return `recording:v1:${callId}:${expires}`;
}

export function recordingAccessExpires() {
  return Math.floor(Date.now() / 1000) + env.recordingUrlTtlSeconds;
}

export function signRecordingAccess(callId: string, expires: number) {
  return createHmac("sha256", env.recordingUrlSigningSecret)
    .update(signaturePayload(callId, expires))
    .digest("base64url");
}

export function verifyRecordingAccess(callId: string, expiresValue: unknown, signatureValue: unknown) {
  const expires = Number(expiresValue);
  const signature = typeof signatureValue === "string" ? signatureValue : "";
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signature) {
    return false;
  }

  const expected = Buffer.from(signRecordingAccess(callId, expires));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
