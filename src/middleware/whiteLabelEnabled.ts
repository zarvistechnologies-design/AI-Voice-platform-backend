import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export function requireWhiteLabelEnabled(
  _request: Request,
  _response: Response,
  next: NextFunction,
) {
  if (!env.whiteLabelEnabled) {
    next(new HttpError(404, "White-label features are not enabled."));
    return;
  }
  next();
}
