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
    // Exotel can omit query parameters when it follows a dynamically resolved
    // WSS endpoint. Put the short-lived credential in the path, which Exotel
    // preserves, while leaving sample-rate as its documented query parameter.
    endpoint.pathname = `${env.exotelStreamPath.replace(/\/$/, "")}/${createExotelStreamToken(env.exotelStreamSecret)}`;
  } else {
    endpoint.username = env.exotelStreamUsername;
    endpoint.password = env.exotelStreamPassword;
  }

  response.setHeader("Cache-Control", "no-store");
  // Exotel's dynamic resolver consumes a JSON object. Keep the URL under the
  // canonical `url` key; a plain-text body is acknowledged with HTTP 200 but
  // does not result in a subsequent WebSocket upgrade.
  response.json({ url: endpoint.toString() });
}
