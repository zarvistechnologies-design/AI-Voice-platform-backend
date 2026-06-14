import type { NextFunction, Request, Response } from "express";

import { UserModel, toPublicUser, type PublicUser } from "../models/User.js";
import { HttpError } from "../utils/httpError.js";
import { verifyAuthToken } from "../utils/jwt.js";

export type AuthenticatedRequest = Request & {
  user?: PublicUser;
};

export async function requireAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  try {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      throw new HttpError(401, "Authentication required.");
    }

    const payload = verifyAuthToken(token);
    const user = await UserModel.findById(payload.sub);

    if (!user) {
      throw new HttpError(401, "Authentication required.");
    }

    request.user = toPublicUser(user);
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Invalid session."));
  }
}
