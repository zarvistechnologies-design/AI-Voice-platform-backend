import type { Request, Response } from "express";

import { isPlatformHostname, resolvePublicBrand } from "../services/whiteLabelService.js";

function requestHostname(request: Request) {
  const query = typeof request.query.hostname === "string" ? request.query.hostname : "";
  if (query) return query;
  const forwarded = String(request.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  return forwarded || request.hostname;
}

export async function publicBrandConfiguration(request: Request, response: Response) {
  const hostname = requestHostname(request).trim().toLowerCase().replace(/:\d+$/, "");
  const brand = await resolvePublicBrand(hostname, isPlatformHostname(hostname));
  if (!brand) {
    response.status(404).json({ message: "This hostname is not an active branded workspace." });
    return;
  }
  response.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
  response.setHeader("Vary", "Host, X-Forwarded-Host");
  response.json({ brand });
}
