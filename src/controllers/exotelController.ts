import type { Request, Response } from "express";

import { env } from "../config/env.js";
import { EXOTEL_SUPPORTED_SAMPLE_RATES } from "../services/exotelProtocol.js";
import { createExotelStreamToken } from "../services/exotelStreamAuth.js";

function publicHttpBase(request: Request) {
  if (env.exotelPublicBaseUrl) return env.exotelPublicBaseUrl;
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const protocol = forwardedProto || request.protocol;
  const host = forwardedHost || request.get("host");
  if (!host) throw new Error("The public Exotel endpoint host could not be determined.");
  return `${protocol}://${host}`;
}

export function exotelVoicebotEndpoint(request: Request, response: Response) {
  if (!env.exotelStreamConfigured) {
    response.status(503).json({
      error: "Exotel voicebot authentication is not configured.",
      required: "Set EXOTEL_STREAM_SECRET or Exotel Basic authentication credentials.",
    });
    return;
  }

  const requestedRate = Number(
    request.query["sample-rate"] ?? request.query.sample_rate ?? request.body?.sample_rate ?? 16_000,
  );
  const sampleRate = EXOTEL_SUPPORTED_SAMPLE_RATES.has(requestedRate) ? requestedRate : 16_000;
  const endpoint = new URL(env.exotelStreamPath, `${publicHttpBase(request)}/`);
  endpoint.protocol = endpoint.protocol === "http:" ? "ws:" : "wss:";
  endpoint.searchParams.set("sample-rate", String(sampleRate));
  if (env.exotelStreamSecret) {
    const credentials = createExotelStreamToken(env.exotelStreamSecret);
    endpoint.searchParams.set("expires", String(credentials.expires));
    endpoint.searchParams.set("nonce", credentials.nonce);
    endpoint.searchParams.set("token", credentials.token);
  } else {
    endpoint.username = env.exotelStreamUsername;
    endpoint.password = env.exotelStreamPassword;
  }

  response.setHeader("Cache-Control", "no-store");
  response.json({ url: endpoint.toString() });
}
