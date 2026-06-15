import type { Response } from "express";

import { env } from "../config/env.js";

const cookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: "lax" as const,
  path: "/",
};

export function setAuthCookie(response: Response, token: string) {
  response.cookie(env.authCookieName, token, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function setRefreshCookie(response: Response, tokenId: string) {
  response.cookie(env.authRefreshCookieName, tokenId, {
    ...cookieOptions,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(response: Response) {
  response.clearCookie(env.authCookieName, cookieOptions);
  response.clearCookie(env.authRefreshCookieName, cookieOptions);
}
