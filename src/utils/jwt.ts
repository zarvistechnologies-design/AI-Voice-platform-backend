import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";

type AuthTokenPayload = JwtPayload & {
  sub: string;
};

export function signAuthToken(userId: string) {
  const options: SignOptions = {
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  };

  return jwt.sign({ sub: userId }, env.jwtSecret, options);
}

export function verifyAuthToken(token: string) {
  return jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
}
