import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

type RazorpayError = { error?: { description?: string; reason?: string } };

export function razorpayConfigured() {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

export async function razorpayRequest<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  if (!razorpayConfigured()) throw new HttpError(503, "Razorpay is not configured.");
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init.method ?? "GET",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64")}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let data: T & RazorpayError;
  try {
    data = JSON.parse(text) as T & RazorpayError;
  } catch {
    throw new HttpError(502, `Razorpay returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new HttpError(502, data.error?.description ?? data.error?.reason ?? "Razorpay request failed.");
  }
  return data;
}
