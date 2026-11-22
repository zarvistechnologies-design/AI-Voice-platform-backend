import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";

export type CrmOAuthProvider = "zoho" | "salesforce";
type OAuthState = { orgId: string; provider: CrmOAuthProvider; sandbox: boolean; nonce: string };
type SavedTokens = { accessToken: string; refreshToken: string; apiBase: string; authBase: string; expiresAt: number };

const zohoAccounts = [
  "https://accounts.zoho.com", "https://accounts.zoho.com.au", "https://accounts.zoho.eu",
  "https://accounts.zoho.in", "https://accounts.zoho.com.cn", "https://accounts.zoho.jp",
  "https://accounts.zohocloud.ca",
];
const zohoApiHosts = new Set([
  "www.zohoapis.com", "www.zohoapis.com.au", "www.zohoapis.eu", "www.zohoapis.in",
  "www.zohoapis.com.cn", "www.zohoapis.jp", "www.zohoapis.ca",
]);

function config(provider: CrmOAuthProvider) {
  const clientId = provider === "zoho" ? env.zohoClientId : env.salesforceClientId;
  const clientSecret = provider === "zoho" ? env.zohoClientSecret : env.salesforceClientSecret;
  const redirectUri = provider === "zoho" ? env.zohoOAuthRedirectUri : env.salesforceOAuthRedirectUri;
  if (!clientId || !clientSecret) throw new HttpError(503, `${provider === "zoho" ? "Zoho CRM" : "Salesforce"} OAuth is not configured in Vozon yet.`);
  return { clientId, clientSecret, redirectUri };
}

function trustedApiBase(provider: CrmOAuthProvider, value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HttpError(400, "The provider returned an invalid API address."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (provider === "zoho" ? !zohoApiHosts.has(host) : !(host.endsWith(".salesforce.com") || host.endsWith(".force.com")))) {
    throw new HttpError(400, "The provider returned an untrusted API address.");
  }
  return url.origin;
}

async function providerRequest(url: string, init: RequestInit, label: string) {
  let response: globalThis.Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) }); }
  catch { throw new HttpError(502, `${label} could not be reached. Try again.`); }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new HttpError(response.status === 401 || response.status === 403 ? 409 : 400, `${label} rejected the connection or its permissions.`);
  }
  return data;
}

function authBase(provider: CrmOAuthProvider, sandbox = false) {
  return provider === "zoho" ? zohoAccounts[0] : sandbox ? "https://test.salesforce.com" : "https://login.salesforce.com";
}

export function crmOAuthUrl(orgId: string, provider: CrmOAuthProvider, sandbox = false) {
  const { clientId, redirectUri } = config(provider);
  const state = jwt.sign({ orgId, provider, sandbox, nonce: randomBytes(16).toString("hex") } satisfies OAuthState, env.jwtSecret, {
    audience: "crm-oauth", expiresIn: "10m",
  });
  const url = new URL(provider === "zoho" ? "/oauth/v2/auth" : "/services/oauth2/authorize", authBase(provider, sandbox));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "zoho") {
    url.searchParams.set("scope", "ZohoCRM.users.READ,ZohoCRM.modules.READ");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("scope", "api refresh_token id");
  }
  return url.toString();
}

function parseState(rawState: string, expectedOrgId: string | undefined, provider: CrmOAuthProvider) {
  let state: OAuthState;
  try { state = jwt.verify(rawState, env.jwtSecret, { audience: "crm-oauth" }) as OAuthState; }
  catch { throw new HttpError(400, "Authorization expired. Start the connection again."); }
  if ((expectedOrgId && state.orgId !== expectedOrgId) || state.provider !== provider) throw new HttpError(403, "This connection belongs to another workspace.");
  return state;
}

function validatedAccountsBase(value: string) {
  const normalized = value.replace(/\/$/, "");
  if (!zohoAccounts.includes(normalized)) throw new HttpError(400, "Zoho returned an unrecognized account region.");
  return normalized;
}

async function exchangeCode(provider: CrmOAuthProvider, code: string, base: string) {
  const { clientId, clientSecret, redirectUri } = config(provider);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
  return providerRequest(
    `${base}${provider === "zoho" ? "/oauth/v2/token" : "/services/oauth2/token"}`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    provider === "zoho" ? "Zoho CRM" : "Salesforce",
  );
}

function tokenFields(provider: CrmOAuthProvider, data: Record<string, unknown>, base: string): SavedTokens {
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const rawApiBase = provider === "zoho" ? data.api_domain : data.instance_url;
  if (!accessToken || !refreshToken || typeof rawApiBase !== "string") {
    throw new HttpError(400, "The provider did not grant persistent API access. Authorize again with refresh access enabled.");
  }
  return {
    accessToken, refreshToken,
    apiBase: trustedApiBase(provider, rawApiBase), authBase: base,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000,
  };
}

async function authenticatedGet(provider: CrmOAuthProvider, tokens: SavedTokens, path: string) {
  return providerRequest(`${tokens.apiBase}${path}`, {
    headers: { Authorization: `${provider === "zoho" ? "Zoho-oauthtoken" : "Bearer"} ${tokens.accessToken}` },
  }, provider === "zoho" ? "Zoho CRM" : "Salesforce");
}

export async function completeCrmOAuth(expectedOrgId: string | undefined, provider: CrmOAuthProvider, code: string, rawState: string, accountsServer = "") {
  const state = parseState(rawState, expectedOrgId, provider);
  const orgId = expectedOrgId || state.orgId;
  const base = provider === "zoho" ? validatedAccountsBase(accountsServer) : authBase(provider, state.sandbox);
  const tokens = tokenFields(provider, await exchangeCode(provider, code, base), base);
  const identity = provider === "zoho"
    ? await authenticatedGet(provider, tokens, "/crm/v8/users?type=CurrentUser")
    : await authenticatedGet(provider, tokens, "/services/oauth2/userinfo");
  const users = Array.isArray(identity.users) ? identity.users as Array<Record<string, unknown>> : [];
  const user = provider === "zoho" ? users[0] : identity;
  const accountId = String(user?.email ?? user?.preferred_username ?? user?.full_name ?? "").trim();
  if (!accountId) throw new HttpError(400, "The provider did not identify the connected account.");
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId: orgId, provider },
    { ownerId: orgId, provider, accountId, secretEncrypted: encryptSecret(JSON.stringify(tokens)), status: "connected", lastVerifiedAt: new Date(), metadata: { authMode: "oauth", region: new URL(tokens.apiBase).hostname } },
    { upsert: true, new: true, runValidators: true },
  );
  await invalidateDashboardCache(orgId);
}

async function savedTokens(orgId: string, provider: CrmOAuthProvider) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId: orgId, provider }).select("+secretEncrypted");
  if (!integration) throw new HttpError(409, `Connect ${provider === "zoho" ? "Zoho CRM" : "Salesforce"} first.`);
  let tokens: SavedTokens;
  try { tokens = JSON.parse(decryptSecret(integration.secretEncrypted)) as SavedTokens; }
  catch { throw new HttpError(409, "The saved OAuth connection is invalid. Reconnect the account."); }
  tokens.apiBase = trustedApiBase(provider, tokens.apiBase);
  if (tokens.expiresAt > Date.now() + 30_000) return tokens;
  const { clientId, clientSecret } = config(provider);
  const base = provider === "zoho" ? validatedAccountsBase(tokens.authBase) : authBase(provider, tokens.authBase === "https://test.salesforce.com");
  const data = await providerRequest(`${base}${provider === "zoho" ? "/oauth/v2/token" : "/services/oauth2/token"}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: clientId, client_secret: clientSecret }),
  }, provider === "zoho" ? "Zoho CRM" : "Salesforce");
  if (typeof data.access_token !== "string") throw new HttpError(409, "The provider did not refresh access. Reconnect the account.");
  tokens.accessToken = data.access_token;
  tokens.expiresAt = Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000;
  if (typeof data.api_domain === "string" && provider === "zoho") tokens.apiBase = trustedApiBase(provider, data.api_domain);
  if (typeof data.instance_url === "string" && provider === "salesforce") tokens.apiBase = trustedApiBase(provider, data.instance_url);
  integration.secretEncrypted = encryptSecret(JSON.stringify(tokens));
  integration.lastVerifiedAt = new Date();
  await integration.save();
  return tokens;
}

export async function previewCrmRecords(orgId: string, provider: CrmOAuthProvider) {
  const tokens = await savedTokens(orgId, provider);
  const data = provider === "zoho"
    ? await authenticatedGet(provider, tokens, "/crm/v8/Contacts?per_page=5&fields=id,Full_Name")
    : await authenticatedGet(provider, tokens, `/services/data/v61.0/query?q=${encodeURIComponent("SELECT Id, Name FROM Contact LIMIT 5")}`);
  const records = provider === "zoho" ? data.data : data.records;
  return { items: (Array.isArray(records) ? records : []).slice(0, 5).map((item: Record<string, unknown>) => ({
    id: String(item.id ?? item.Id ?? ""), name: String(item.Full_Name ?? item.Name ?? "Contact"), type: "Contact",
  })) };
}

export async function disconnectCrmOAuth(orgId: string, provider: CrmOAuthProvider) {
  await ProviderIntegrationModel.deleteOne({ ownerId: orgId, provider });
  await VoiceAgentModel.updateMany({ ownerId: orgId }, { $pull: { integrationReadProviders: provider } });
  await invalidateDashboardCache(orgId);
}
