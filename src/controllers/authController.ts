import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";

import { env } from "../config/env.js";
import { type AuthenticatedRequest } from "../middleware/auth.js";
import { AuthSessionModel } from "../models/AuthSession.js";
import { UserModel, toPublicUser } from "../models/User.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { ensureDefaultOrganization, resolveActiveOrganization } from "../services/organizationService.js";
import { clearAuthCookie, setAuthCookie, setRefreshCookie } from "../utils/authCookie.js";
import { HttpError } from "../utils/httpError.js";
import { signAuthToken } from "../utils/jwt.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { createTotpSecret, verifyTotp } from "../utils/totp.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthBody = {
  name?: string;
  email?: string;
  password?: string;
  token?: string;
  twoFactorCode?: string;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validateEmail(email: string) {
  if (!emailPattern.test(email)) throw new HttpError(400, "Enter a valid email address.");
}

function validatePassword(password: string) {
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function requestIp(request: Request) {
  return String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "").split(",")[0].trim();
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

async function issueSession(request: Request, response: Response, userId: string, orgId: string) {
  const tokenId = randomUUID();
  await AuthSessionModel.create({
    userId,
    orgId,
    tokenId,
    device: String(request.headers["user-agent"] ?? "Unknown device").slice(0, 500),
    ip: requestIp(request),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  setAuthCookie(response, signAuthToken(userId, orgId, tokenId));
  setRefreshCookie(response, tokenId);
}

async function verificationFor(user: { id?: string; _id?: unknown; email: string }) {
  const userId = user.id ?? String(user._id);
  const token = randomBytes(32).toString("hex");
  await UserModel.updateOne({ _id: userId }, { verificationTokenHash: tokenHash(token) });
  const url = `${env.clientUrl}/verify-email?token=${token}`;
  void sendTransactionalEmail({
    userId,
    to: user.email,
    subject: "Verify your AI Voice Platform email",
    kind: "verification",
    text: `Verify your email by opening this link: ${url}`,
  }).catch(console.error);
  return url;
}

export async function register(request: Request, response: Response) {
  const { name, email, password } = request.body as AuthBody;
  const normalizedName = name?.trim();
  const normalizedEmail = normalizeEmail(email ?? "");
  const rawPassword = password ?? "";
  if (!normalizedName || normalizedName.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
  validateEmail(normalizedEmail);
  validatePassword(rawPassword);
  if (await UserModel.exists({ email: normalizedEmail })) throw new HttpError(409, "An account with this email already exists.");

  const user = await UserModel.create({
    name: normalizedName,
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(rawPassword, 12),
  });
  const { organization } = await ensureDefaultOrganization(user);
  await issueSession(request, response, user.id, organization.id);
  const verificationUrl = await verificationFor(user);
  response.status(201).json({
    user: toPublicUser(user),
    organization,
    ...(env.nodeEnv === "development" ? { verificationUrl } : {}),
  });
}

export async function login(request: Request, response: Response) {
  const { email, password, twoFactorCode } = request.body as AuthBody;
  const normalizedEmail = normalizeEmail(email ?? "");
  const rawPassword = password ?? "";
  validateEmail(normalizedEmail);
  validatePassword(rawPassword);
  const user = await UserModel.findOne({ email: normalizedEmail }).select("+passwordHash +twoFactorSecretEncrypted");
  if (!user) throw new HttpError(401, "Invalid email or password.");
  if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
    throw new HttpError(423, "This account is temporarily locked after repeated failed login attempts.");
  }
  if (!(await bcrypt.compare(rawPassword, user.passwordHash))) {
    user.loginAttempts += 1;
    if (user.loginAttempts >= 5) user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();
    throw new HttpError(401, "Invalid email or password.");
  }
  if (env.requireEmailVerification && !user.emailVerified) throw new HttpError(403, "Verify your email before signing in.");
  if (user.twoFactorEnabled) {
    if (!twoFactorCode) throw new HttpError(401, "Two-factor code required.");
    if (!user.twoFactorSecretEncrypted || !verifyTotp(decryptSecret(user.twoFactorSecretEncrypted), twoFactorCode)) {
      throw new HttpError(401, "Invalid two-factor code.");
    }
  }
  user.loginAttempts = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  user.lastLoginIp = requestIp(request);
  await user.save();
  const { organization } = await ensureDefaultOrganization(user);
  await issueSession(request, response, user.id, organization.id);
  response.json({ user: toPublicUser(user), organization });
}

export async function me(request: AuthenticatedRequest, response: Response) {
  response.json({ user: request.user, organization: request.organization });
}

export async function refresh(request: Request, response: Response) {
  const tokenId = cookieValue(request, env.authRefreshCookieName);
  if (!tokenId) throw new HttpError(401, "Refresh session required.");
  const session = await AuthSessionModel.findOne({
    tokenId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new HttpError(401, "Refresh session expired or revoked.");
  const user = await UserModel.findById(session.userId);
  if (!user) throw new HttpError(401, "Refresh session user is no longer active.");
  const { organization } = await resolveActiveOrganization(user, String(session.orgId));
  session.orgId = organization._id;
  session.lastSeenAt = new Date();
  session.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await session.save();
  setAuthCookie(response, signAuthToken(user.id, organization.id, session.tokenId));
  setRefreshCookie(response, session.tokenId);
  response.json({ user: toPublicUser(user), organization });
}

export async function logout(request: AuthenticatedRequest, response: Response) {
  if (request.sessionId) await AuthSessionModel.updateOne({ tokenId: request.sessionId }, { revokedAt: new Date() });
  clearAuthCookie(response);
  response.status(204).end();
}

export async function verifyEmail(request: Request, response: Response) {
  const token = typeof request.body.token === "string" ? request.body.token : "";
  const user = await UserModel.findOne({ verificationTokenHash: tokenHash(token) }).select("+verificationTokenHash");
  if (!user) throw new HttpError(410, "Verification link is invalid or expired.");
  user.emailVerified = true;
  user.verificationTokenHash = "";
  await user.save();
  response.status(204).end();
}

export async function resendVerification(request: AuthenticatedRequest, response: Response) {
  const user = await UserModel.findById(request.user?.id);
  if (!user) throw new HttpError(401, "Authentication required.");
  if (user.emailVerified) throw new HttpError(409, "Email is already verified.");
  const verificationUrl = await verificationFor(user);
  response.json({ sent: true, ...(env.nodeEnv === "development" ? { verificationUrl } : {}) });
}

export async function forgotPassword(request: Request, response: Response) {
  const email = normalizeEmail(String(request.body.email ?? ""));
  validateEmail(email);
  const user = await UserModel.findOne({ email });
  let resetUrl = "";
  if (user) {
    const token = randomBytes(32).toString("hex");
    user.passwordResetTokenHash = tokenHash(token);
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    resetUrl = `${env.clientUrl}/reset-password?token=${token}`;
    void sendTransactionalEmail({
      userId: user.id,
      to: user.email,
      subject: "Reset your AI Voice Platform password",
      kind: "password-reset",
      text: `Reset your password within one hour: ${resetUrl}`,
    }).catch(console.error);
  }
  response.json({ sent: true, ...(env.nodeEnv === "development" && resetUrl ? { resetUrl } : {}) });
}

export async function resetPassword(request: Request, response: Response) {
  const token = String(request.body.token ?? "");
  const password = String(request.body.password ?? "");
  validatePassword(password);
  const user = await UserModel.findOne({
    passwordResetTokenHash: tokenHash(token),
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetTokenHash");
  if (!user) throw new HttpError(410, "Password reset link is invalid or expired.");
  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordResetTokenHash = "";
  user.passwordResetExpires = undefined;
  await user.save();
  await AuthSessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
  response.status(204).end();
}

export async function changePassword(request: AuthenticatedRequest, response: Response) {
  const currentPassword = String(request.body.currentPassword ?? "");
  const password = String(request.body.password ?? "");
  validatePassword(password);
  const user = await UserModel.findById(request.user?.id).select("+passwordHash");
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw new HttpError(401, "Current password is incorrect.");
  user.passwordHash = await bcrypt.hash(password, 12);
  await user.save();
  await AuthSessionModel.updateMany({ userId: user._id, tokenId: { $ne: request.sessionId }, revokedAt: { $exists: false } }, { revokedAt: new Date() });
  response.status(204).end();
}

export async function listSessions(request: AuthenticatedRequest, response: Response) {
  const sessions = await AuthSessionModel.find({ userId: request.user?.id, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 });
  response.json({ sessions: sessions.map((session) => ({ ...session.toObject(), current: session.tokenId === request.sessionId, tokenId: undefined })) });
}

export async function revokeSession(request: AuthenticatedRequest, response: Response) {
  const session = await AuthSessionModel.findOneAndUpdate({ _id: request.params.sessionId, userId: request.user?.id }, { revokedAt: new Date() });
  if (!session) throw new HttpError(404, "Session not found.");
  if (session.tokenId === request.sessionId) clearAuthCookie(response);
  response.status(204).end();
}

export async function setupTwoFactor(request: AuthenticatedRequest, response: Response) {
  const user = await UserModel.findById(request.user?.id).select("+twoFactorSecretEncrypted");
  if (!user) throw new HttpError(401, "Authentication required.");
  const secret = createTotpSecret();
  user.twoFactorSecretEncrypted = encryptSecret(secret);
  user.twoFactorEnabled = false;
  await user.save();
  const issuer = encodeURIComponent("AI Voice Platform");
  const label = encodeURIComponent(`${user.email}`);
  response.json({ secret, otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}` });
}

export async function verifyTwoFactor(request: AuthenticatedRequest, response: Response) {
  const user = await UserModel.findById(request.user?.id).select("+twoFactorSecretEncrypted");
  if (!user?.twoFactorSecretEncrypted || !verifyTotp(decryptSecret(user.twoFactorSecretEncrypted), String(request.body.code ?? ""))) {
    throw new HttpError(400, "Invalid two-factor code.");
  }
  user.twoFactorEnabled = true;
  await user.save();
  response.status(204).end();
}

export async function disableTwoFactor(request: AuthenticatedRequest, response: Response) {
  const user = await UserModel.findById(request.user?.id).select("+twoFactorSecretEncrypted");
  if (!user?.twoFactorSecretEncrypted || !verifyTotp(decryptSecret(user.twoFactorSecretEncrypted), String(request.body.code ?? ""))) {
    throw new HttpError(400, "Invalid two-factor code.");
  }
  user.twoFactorEnabled = false;
  user.twoFactorSecretEncrypted = "";
  await user.save();
  response.status(204).end();
}
