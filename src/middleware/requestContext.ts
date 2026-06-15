import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export type RequestWithId = Express.Request & { requestId?: string };

export const requestContext: RequestHandler = (request, response, next) => {
  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  (request as RequestWithId).requestId = requestId;
  response.setHeader("X-Request-ID", requestId);
  const startedAt = Date.now();
  response.once("finish", () => {
    console.log(JSON.stringify({
      level: "info",
      event: "http_request",
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
};
