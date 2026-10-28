import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";

type RazorpayState = { orgId: string; nonce: string; mode: "test" | "live" };
type RazorpayTokens = { accessToken: string; refreshToken: string; expiresAt: number; mode: "test" | "live"; accountId: string };

function config(mode: "test" | "live" = "live") {
  const clientId = mode === "test" ? env.razorpayOAuthTestClientId : env.razorpayOAuthClientId;
  const clientSecret = mode === "test" ? env.razorpayOAuthTestClientSecret : env.razorpayOAuthClientSecret;
  if (!clientId || !clientSecret) {
    throw new HttpError(503, `Razorpay ${mode} OAuth needs a Razorpay platform-partner application configured by Vozon.`);
  }
  return { clientId, clientSecret, redirectUri: env.razorpayOAuthRedirectUri };
}

export function razorpayOAuthUrl(orgId: string, mode: "test" | "live" = "live") {
  const { clientId, redirectUri } = config(mode);
  const state = jwt.sign({ orgId, mode, nonce: randomBytes(16).toString("hex") } satisfies RazorpayState, env.jwtSecret, { audience: "razorpay-oauth", expiresIn: "10m" });
  const url = new URL("https://auth.razorpay.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read_only");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>) {
  let response: globalThis.Response;
  try {
    response = await fetch("https://auth.razorpay.com/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
    });
  } catch { throw new HttpError(502, "Razorpay authorization service could not be reached."); }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new HttpError(400, "Razorpay rejected the authorization. Try again.");
  return data;
}

async function readPayments(accessToken: string) {
  let response: globalThis.Response;
  try {
    response = await fetch("https://api.razorpay.com/v1/payments?count=5", {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12_000),
    });
  } catch { throw new HttpError(502, "Razorpay payments could not be reached."); }
  const data = await response.json().catch(() => ({})) as { items?: Array<Record<string, unknown>> };
  if (!response.ok) throw new HttpError(response.status === 401 ? 409 : 400, "Razorpay rejected access to merchant payments.");
  return {
    payments: (Array.isArray(data.items) ? data.items : []).slice(0, 5).map((payment) => ({
      id: String(payment.id ?? ""), amount: Number(payment.amount ?? 0), currency: String(payment.currency ?? "INR"),
      status: String(payment.status ?? "unknown"), createdAt: Number(payment.created_at ?? 0),
    })),
  };
}

export async function completeRazorpayOAuth(expectedOrgId: string | undefined, code: string, rawState: string) {
  let state: RazorpayState;
  try { state = jwt.verify(rawState, env.jwtSecret, { audience: "razorpay-oauth" }) as RazorpayState; }
  catch { throw new HttpError(400, "Razorpay authorization expired. Start the connection again."); }
  if ((expectedOrgId && state.orgId !== expectedOrgId) || !["test", "live"].includes(state.mode)) throw new HttpError(403, "This connection belongs to another workspace.");
  const orgId = expectedOrgId || state.orgId;
  const { clientId, clientSecret, redirectUri } = config(state.mode);
  const data = await tokenRequest({ client_id: clientId, client_secret: clientSecret, grant_type: "authorisation_code", redirect_uri: redirectUri, code, mode: state.mode });
  const accountId = typeof data.razorpay_account_id === "string" ? data.razorpay_account_id : "";
  if (!accountId || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new HttpError(400, "Razorpay did not grant persistent merchant access.");
  }
  await readPayments(data.access_token);
  const tokens: RazorpayTokens = {
    accessToken: data.access_token, refreshToken: data.refresh_token, accountId, mode: state.mode,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000,
  };
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId: orgId, provider: "razorpay_oauth" },
    { ownerId: orgId, provider: "razorpay_oauth", accountId, secretEncrypted: encryptSecret(JSON.stringify(tokens)), status: "connected", lastVerifiedAt: new Date(), metadata: { authMode: "oauth", mode: state.mode } },
    { upsert: true, new: true, runValidators: true },
  );
  await invalidateDashboardCache(orgId);
}

export async function previewRazorpayOAuthPayments(orgId: string) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId: orgId, provider: "razorpay_oauth" }).select("+secretEncrypted");
  if (!integration) throw new HttpError(409, "Connect a Razorpay merchant account first.");
  let tokens: RazorpayTokens;
  try { tokens = JSON.parse(decryptSecret(integration.secretEncrypted)) as RazorpayTokens; }
  catch { throw new HttpError(409, "The saved Razorpay connection is invalid. Reconnect the account."); }
  if (tokens.expiresAt <= Date.now() + 30_000) {
    const { clientId, clientSecret } = config(tokens.mode);
    const data = await tokenRequest({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") throw new HttpError(409, "Razorpay access expired. Reconnect the account.");
    tokens = {
      ...tokens, accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000,
    };
    integration.secretEncrypted = encryptSecret(JSON.stringify(tokens));
    integration.lastVerifiedAt = new Date();
    await integration.save();
  }
  return readPayments(tokens.accessToken);
}

export async function disconnectRazorpayOAuth(orgId: string) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId: orgId, provider: "razorpay_oauth" }).select("+secretEncrypted");
  if (integration) {
    try {
      const tokens = JSON.parse(decryptSecret(integration.secretEncrypted)) as RazorpayTokens;
      const { clientId, clientSecret } = config(tokens.mode);
      await fetch("https://auth.razorpay.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token_type_hint: "refresh_token", token: tokens.refreshToken }),
      });
    } catch { /* Delete the local credential even if Razorpay cannot revoke it. */ }
  }
  await ProviderIntegrationModel.deleteOne({ ownerId: orgId, provider: "razorpay_oauth" });
  await VoiceAgentModel.updateMany({ ownerId: orgId }, { $pull: { integrationReadProviders: "razorpay_oauth" } });
  await invalidateDashboardCache(orgId);
}
