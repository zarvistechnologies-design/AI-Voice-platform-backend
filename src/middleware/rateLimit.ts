import type { RequestHandler } from "express";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  message: string;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export function createRateLimit({ windowMs, max, message }: RateLimitOptions): RequestHandler {
  const entries = new Map<string, RateLimitEntry>();

  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const existing = entries.get(key);
    const entry = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;

    entry.count += 1;
    entries.set(key, entry);

    if (entries.size > 10_000) {
      for (const [entryKey, value] of entries) {
        if (value.resetAt <= now) entries.delete(entryKey);
      }
      while (entries.size > 10_000) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        entries.delete(oldestKey);
      }
    }

    const remaining = Math.max(0, max - entry.count);
    response.setHeader("RateLimit-Limit", String(max));
    response.setHeader("RateLimit-Remaining", String(remaining));
    response.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      response.status(429).json({ message });
      return;
    }

    next();
  };
}
