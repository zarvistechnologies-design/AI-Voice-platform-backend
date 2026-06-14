import type { ErrorRequestHandler, RequestHandler } from "express";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new HttpError(404, `Route not found: ${request.method} ${request.path}`));
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message =
    error instanceof Error && error.message ? error.message : "Something went wrong";

  response.status(statusCode).json({
    message,
    ...(env.nodeEnv === "development" && error instanceof Error
      ? { stack: error.stack }
      : {}),
  });
};
