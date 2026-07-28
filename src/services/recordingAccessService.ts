import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";

function recordingSignature(callId: string, expires: number) {
  return createHmac("sha256", env.recordingLinkSecret)
    .update(`v1:${callId}:${expires}`)
    .digest("base64url");
}

export function createRecordingAccessPath(callId: string, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + env.recordingLinkTtlSeconds;
  const query = new URLSearchParams({
    expires: String(expires),
    token: recordingSignature(callId, expires),
  });
  return {
    path: `/api/v1/calls/${encodeURIComponent(callId)}/recording/play?${query.toString()}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export function verifyRecordingAccess(callId: string, expiresValue: unknown, tokenValue: unknown, nowMs = Date.now()) {
  const expiresText = typeof expiresValue === "string" ? expiresValue : "";
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!/^\d+$/.test(expiresText) || !token) return false;

  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(nowMs / 1000)) return false;

  const expected = Buffer.from(recordingSignature(callId, expires));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
