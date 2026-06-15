import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { AuditLogModel } from "../src/models/AuditLog.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const suffix = Date.now();
let ownerId = "";

await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function splitSetCookie(header: string) {
  return header.split(/,(?=\s*[^;=]+=[^;]+)/g).map((item) => item.trim()).filter(Boolean);
}

function setCookies(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const direct = extended.getSetCookie?.();
  if (direct?.length) return direct;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookie(combined) : [];
}

function cookieHeader(cookies: string[]) {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function cookieNamed(cookies: string[], name: string) {
  const cookie = cookies.map((item) => item.split(";")[0]).find((item) => item.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing cookie ${name}`);
  return cookie;
}

async function api(path: string, input: { method?: string; body?: unknown; cookie?: string } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: { ...(input.body ? { "Content-Type": "application/json" } : {}), ...(input.cookie ? { Cookie: input.cookie } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), cookies: setCookies(response.headers) };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Twelve User", email: `phase12-${suffix}@example.com`, password: "phase-twelve-password" },
  });
  ownerId = (registration.data as { user: { id: string } }).user.id;
  const refreshCookie = cookieNamed(registration.cookies, env.authRefreshCookieName);
  cookieNamed(registration.cookies, env.authCookieName);

  const refreshed = await api("/api/auth/refresh", { method: "POST", cookie: refreshCookie });
  if (refreshed.status !== 200 || (refreshed.data as { user?: { id: string } }).user?.id !== ownerId) {
    throw new Error(`Refresh with only refresh cookie failed: ${JSON.stringify(refreshed.data)}`);
  }
  const refreshedCookieHeader = cookieHeader(refreshed.cookies);
  cookieNamed(refreshed.cookies, env.authCookieName);
  cookieNamed(refreshed.cookies, env.authRefreshCookieName);

  const me = await api("/api/auth/me", { cookie: refreshedCookieHeader });
  if (me.status !== 200 || (me.data as { user?: { id: string } }).user?.id !== ownerId) {
    throw new Error("Refreshed access cookie did not authenticate /me.");
  }

  const session = await AuthSessionModel.findOne({ userId: ownerId, revokedAt: { $exists: false } });
  if (!session?.orgId || session.expiresAt.getTime() <= Date.now() + 20 * 24 * 60 * 60 * 1000) {
    throw new Error("Refresh session did not persist active org and 30-day expiry.");
  }

  const logout = await api("/api/auth/logout", { method: "POST", cookie: refreshedCookieHeader });
  if (logout.status !== 204) throw new Error("Logout failed after refresh.");
  const revoked = await api("/api/auth/refresh", { method: "POST", cookie: refreshCookie });
  if (revoked.status !== 401) throw new Error("Revoked refresh cookie was accepted.");

  console.log(JSON.stringify({
    passed: true,
    checks: ["refresh cookie issued", "refresh works without access cookie", "refreshed access authenticates", "active org persisted on session", "logout revokes refresh"],
  }));
} finally {
  server.close();
  if (ownerId) {
    await Promise.all([
      AuditLogModel.deleteMany({ orgId: ownerId }),
      AuthSessionModel.deleteMany({ userId: ownerId }),
      EmailDeliveryModel.deleteMany({ userId: ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
