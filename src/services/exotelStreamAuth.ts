import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_TOKEN_LIFETIME_SECONDS = 5 * 60;

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(secret: string, expires: number, nonce: string) {
  return createHmac("sha256", secret)
    .update(`${expires}.${nonce}`)
    .digest("base64url");
}

export function createExotelStreamToken(secret: string, lifetimeSeconds = 120) {
  const expires = Math.floor(Date.now() / 1_000) + Math.min(MAX_TOKEN_LIFETIME_SECONDS, Math.max(10, lifetimeSeconds));
  const nonce = randomUUID();
  return `${expires}.${nonce}.${signature(secret, expires, nonce)}`;
}

export function validateExotelStreamToken(input: {
  secret: string;
  token: string;
}) {
  if (!input.secret || !input.token) return false;
  const [expiresValue, nonce, providedSignature, ...extra] = input.token.split(".");
  if (extra.length || !expiresValue || !providedSignature || !/^[a-f0-9-]{36}$/i.test(nonce ?? "")) {
    return false;
  }
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(expires) || expires < now - 5 || expires > now + MAX_TOKEN_LIFETIME_SECONDS) return false;
  return safeEqual(providedSignature, signature(input.secret, expires, nonce!));
}

export function safelyEqualExotelCredential(left: string, right: string) {
  return Boolean(left && right && safeEqual(left, right));
}
