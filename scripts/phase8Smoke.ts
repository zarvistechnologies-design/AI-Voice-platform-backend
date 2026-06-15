import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decode(secret: string) {
  let bits = "";
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret: string) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hash = createHmac("sha1", decode(secret)).update(message).digest();
  const offset = hash[hash.length - 1] & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}

const suffix = Date.now();
const email = `phase8-${suffix}@example.com`;
let userId = "";
let cookie = "";
await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(path: string, input: { method?: string; body?: unknown; useCookie?: boolean } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: { ...(input.body ? { "Content-Type": "application/json" } : {}), ...(input.useCookie === false || !cookie ? {} : { Cookie: cookie }) },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Eight Smoke", email, password: "phase-eight-password" },
  });
  cookie = registration.cookie;
  userId = (registration.data as { user: { id: string }; verificationUrl: string }).user.id;
  const verificationUrl = (registration.data as { verificationUrl: string }).verificationUrl;
  if (registration.status !== 201 || !verificationUrl) throw new Error("Registration did not create a verification flow.");
  const verification = await api("/api/auth/verify-email", { method: "POST", body: { token: new URL(verificationUrl).searchParams.get("token") }, useCookie: false });
  if (verification.status !== 204 || !(await UserModel.findById(userId))?.emailVerified) throw new Error("Email verification failed.");

  const sessions = await api("/api/auth/sessions");
  const current = (sessions.data as { sessions: { _id: string; current: boolean }[] }).sessions.find((session) => session.current);
  if (sessions.status !== 200 || !current) throw new Error("Current session was not listed.");

  const setup = await api("/api/auth/2fa/setup", { method: "POST" });
  const secret = (setup.data as { secret: string }).secret;
  const enabled = await api("/api/auth/2fa/verify", { method: "POST", body: { code: totp(secret) } });
  if (enabled.status !== 204) throw new Error("TOTP setup failed.");
  const logout = await api("/api/auth/logout", { method: "POST" });
  if (logout.status !== 204) throw new Error("Logout failed.");
  const revoked = await api("/api/auth/me");
  if (revoked.status !== 401) throw new Error("Logged-out session was not revoked.");

  const noTwoFactor = await api("/api/auth/login", { method: "POST", body: { email, password: "phase-eight-password" }, useCookie: false });
  if (noTwoFactor.status !== 401) throw new Error("2FA-protected login did not require a code.");
  const login = await api("/api/auth/login", { method: "POST", body: { email, password: "phase-eight-password", twoFactorCode: totp(secret) }, useCookie: false });
  cookie = login.cookie;
  if (login.status !== 200 || !cookie) throw new Error("TOTP login failed.");

  const forgot = await api("/api/auth/forgot-password", { method: "POST", body: { email }, useCookie: false });
  const resetUrl = (forgot.data as { resetUrl: string }).resetUrl;
  const reset = await api("/api/auth/reset-password", { method: "POST", body: { token: new URL(resetUrl).searchParams.get("token"), password: "phase-eight-new-password" }, useCookie: false });
  if (reset.status !== 204) throw new Error("Password reset failed.");
  const invalidated = await api("/api/auth/me");
  if (invalidated.status !== 401) throw new Error("Password reset did not revoke existing sessions.");

  const user = await UserModel.findById(userId).select("+twoFactorSecretEncrypted");
  if (!user?.twoFactorSecretEncrypted) throw new Error("Encrypted TOTP secret missing.");
  if ((await EmailDeliveryModel.countDocuments({ userId })) < 2) throw new Error("Verification and reset email deliveries were not tracked.");

  console.log(JSON.stringify({
    passed: true,
    checks: ["email verification token", "email delivery tracking", "persistent session list", "logout revocation", "encrypted TOTP setup", "TOTP login challenge", "password reset token", "password reset session revocation"],
  }));
} finally {
  server.close();
  if (userId) {
    await Promise.all([
      AuthSessionModel.deleteMany({ userId }),
      EmailDeliveryModel.deleteMany({ userId }),
      OrganizationMemberModel.deleteMany({ userId }),
      OrganizationModel.deleteOne({ _id: userId }),
      UserModel.deleteOne({ _id: userId }),
    ]);
  }
  await mongoose.disconnect();
}
