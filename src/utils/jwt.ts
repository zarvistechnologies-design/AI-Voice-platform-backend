import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";

type AuthTokenPayload = JwtPayload & {
  sub: string;
  orgId?: string;
  sid?: string;
};

export function signAuthToken(userId: string, orgId?: string, sessionId?: string) {
  const options: SignOptions = {
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  };

  return jwt.sign({ sub: userId, orgId, sid: sessionId }, env.jwtSecret, options);
}

export function verifyAuthToken(token: string) {
  return jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
}
