import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";

type ShopifyState = { orgId: string; shop: string; nonce: string };
type ShopifyTokens = { accessToken: string; refreshToken: string; expiresAt: number; refreshTokenExpiresAt: number };

function credentials() {
  if (!env.shopifyClientId || !env.shopifyClientSecret) {
    throw new HttpError(503, "Shopify connection needs a Shopify app Client ID and Client Secret configured by Vozon.");
  }
  return { clientId: env.shopifyClientId, clientSecret: env.shopifyClientSecret, redirectUri: env.shopifyOAuthRedirectUri };
}

export function normalizeShopifyDomain(value: string) {
  const cleaned = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cleaned)) {
    throw new HttpError(400, "Enter your Shopify store domain, for example your-store.myshopify.com.");
  }
  return cleaned;
}

export function shopifyOAuthUrl(orgId: string, rawShop: string) {
  const shop = normalizeShopifyDomain(rawShop);
  const { clientId, redirectUri } = credentials();
  const state = jwt.sign({ orgId, shop, nonce: randomBytes(16).toString("hex") } satisfies ShopifyState, env.jwtSecret, {
    audience: "shopify-oauth",
    expiresIn: "10m",
  });
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "read_products,read_orders");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function verifyShopifyCallbackHmac(query: Record<string, unknown>) {
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided || !/^[a-f0-9]{64}$/i.test(provided)) throw new HttpError(401, "Shopify authorization signature is missing or invalid.");
  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join("&");
  const expected = createHmac("sha256", env.shopifyClientSecret).update(message).digest("hex");
  const providedBytes = Buffer.from(provided, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    throw new HttpError(401, "Shopify authorization signature could not be verified.");
  }
}

async function tokenRequest(shop: string, body: Record<string, string>) {
  let response: globalThis.Response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.shopifyClientId, client_secret: env.shopifyClientSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Shopify authorization service could not be reached.");
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new HttpError(400, "Shopify rejected the authorization. Check the app setup and try again.");
  return data;
}

export async function completeShopifyOAuth(rawCode: string, rawState: string, query: Record<string, unknown>) {
  credentials();
  verifyShopifyCallbackHmac(query);
  let state: ShopifyState;
  try {
    state = jwt.verify(rawState, env.jwtSecret, { audience: "shopify-oauth" }) as ShopifyState;
  } catch {
    throw new HttpError(400, "Shopify authorization expired. Start the connection again.");
  }
  const shop = normalizeShopifyDomain(String(query.shop || ""));
  if (!state.orgId || !state.nonce || state.shop !== shop) throw new HttpError(403, "This Shopify authorization does not match the store you selected.");

  // Expiring offline credentials are required for new Shopify apps.
  const data = await tokenRequest(shop, { code: rawCode, expiring: "1" });
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new HttpError(400, "Shopify did not return renewable offline access. Confirm expiring offline tokens are enabled for the app.");
  }
  const grantedScopes = typeof data.scope === "string" ? data.scope.split(",").map((scope) => scope.trim()) : [];
  if (!["read_products", "read_orders"].every((scope) => grantedScopes.includes(scope))) {
    throw new HttpError(403, "Shopify did not grant product and order read access. Reinstall the app with both permissions.");
  }

  const tokens: ShopifyTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
    refreshTokenExpiresAt: Date.now() + Math.max(60, Number(data.refresh_token_expires_in || 7_776_000) - 60) * 1000,
  };
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId: state.orgId, provider: "shopify" },
    {
      ownerId: state.orgId,
      provider: "shopify",
      accountId: shop,
      secretEncrypted: encryptSecret(JSON.stringify(tokens)),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: { authMode: "oauth", shopDomain: shop, scopes: grantedScopes },
    },
    { upsert: true, new: true, runValidators: true },
  );
  await invalidateDashboardCache(state.orgId);
  return state.orgId;
}

async function getShopifyIntegration(ownerId: string) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId, provider: "shopify", status: "connected" }).select("+secretEncrypted");
  if (!integration) throw new HttpError(409, "Connect a Shopify store first.");
  return integration;
}

async function accessTokenForIntegration(integration: Awaited<ReturnType<typeof getShopifyIntegration>>) {
  let tokens: ShopifyTokens;
  try { tokens = JSON.parse(decryptSecret(integration.secretEncrypted)) as ShopifyTokens; }
  catch { throw new HttpError(409, "The saved Shopify connection is invalid. Reconnect the store."); }
  if (tokens.expiresAt > Date.now() + 30_000) return { integration, tokens };
  if (tokens.refreshTokenExpiresAt <= Date.now() + 30_000) throw new HttpError(409, "Shopify authorization expired. Reconnect the store.");
  const shop = normalizeShopifyDomain(integration.accountId);
  const data = await tokenRequest(shop, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new HttpError(409, "Shopify access expired. Reconnect the store.");
  }
  tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
    refreshTokenExpiresAt: Date.now() + Math.max(60, Number(data.refresh_token_expires_in || 7_776_000) - 60) * 1000,
  };
  integration.secretEncrypted = encryptSecret(JSON.stringify(tokens));
  integration.lastVerifiedAt = new Date();
  await integration.save();
  return { integration, tokens };
}

async function shopifyGraphql<T>(ownerId: string, query: string): Promise<T> {
  const integration = await getShopifyIntegration(ownerId);
  const { tokens } = await accessTokenForIntegration(integration);
  const shop = normalizeShopifyDomain(integration.accountId);
  let response: globalThis.Response;
  try {
    response = await fetch(`https://${shop}/admin/api/${encodeURIComponent(env.shopifyApiVersion)}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tokens.accessToken },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new HttpError(502, "Shopify store could not be reached."); }
  const data = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || data.errors?.length || !data.data) {
    if (response.status === 401 || response.status === 403) throw new HttpError(409, "Shopify denied this request. Reconnect the store and confirm the requested read permissions.");
    throw new HttpError(502, data.errors?.[0]?.message || "Shopify could not return store data.");
  }
  return data.data;
}

export async function previewShopifyStore(ownerId: string) {
  const data = await shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string; primaryDomain: { url: string } };
    products: { edges: Array<{ node: { id: string; title: string; handle: string; status: string; productType: string } }> };
    orders: { edges: Array<{ node: { id: string; name: string; createdAt: string; displayFinancialStatus: string | null; displayFulfillmentStatus: string | null; currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }> };
  }>(ownerId, `query VozonShopifyPreview {
    shop { name myshopifyDomain primaryDomain { url } }
    products(first: 8, sortKey: TITLE) { edges { node { id title handle status productType } } }
    orders(first: 8, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } } } } }
  }`);
  return {
    shop: data.shop,
    products: data.products.edges.map(({ node }) => ({
      id: node.id, title: node.title, handle: node.handle, status: node.status,
      productType: node.productType,
    })),
    orders: data.orders.edges.map(({ node }) => ({
      id: node.id, name: node.name, createdAt: node.createdAt,
      financialStatus: node.displayFinancialStatus || "unknown",
      fulfillmentStatus: node.displayFulfillmentStatus || "unfulfilled",
      total: node.currentTotalPriceSet.shopMoney.amount,
      currency: node.currentTotalPriceSet.shopMoney.currencyCode,
    })),
  };
}

export async function disconnectShopify(ownerId: string) {
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "shopify" });
  await VoiceAgentModel.updateMany({ ownerId }, { $pull: { integrationReadProviders: "shopify" } });
  await invalidateDashboardCache(ownerId);
}
