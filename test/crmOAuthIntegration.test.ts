import assert from "node:assert/strict";
import test, { after } from "node:test";

import { env } from "../src/config/env.js";
import { crmOAuthUrl, completeCrmOAuth } from "../src/services/crmOAuthService.js";
import { closeDashboardCache } from "../src/services/dashboardCacheService.js";
import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { decryptSecret } from "../src/utils/secretCrypto.js";

after(closeDashboardCache);

test("Zoho and Salesforce produce workspace-bound authorization URLs", async () => {
  const old = [env.zohoClientId, env.zohoClientSecret, env.salesforceClientId, env.salesforceClientSecret];
  env.zohoClientId = "zoho-client";
  env.zohoClientSecret = "zoho-secret";
  env.salesforceClientId = "salesforce-client";
  env.salesforceClientSecret = "salesforce-secret";
  try {
    const zoho = new URL(crmOAuthUrl("org-1", "zoho"));
    assert.equal(zoho.host, "accounts.zoho.com");
    assert.equal(zoho.searchParams.get("scope"), "ZohoCRM.users.READ,ZohoCRM.modules.READ");
    assert.equal(zoho.searchParams.get("access_type"), "offline");
    await assert.rejects(completeCrmOAuth("org-2", "zoho", "code", zoho.searchParams.get("state")!, "https://accounts.zoho.com"), /another workspace/);

    const salesforce = new URL(crmOAuthUrl("org-1", "salesforce", true));
    assert.equal(salesforce.host, "test.salesforce.com");
    assert.match(salesforce.searchParams.get("scope") ?? "", /refresh_token/);
    await assert.rejects(completeCrmOAuth("org-1", "zoho", "code", salesforce.searchParams.get("state")!, "https://accounts.zoho.com"), /another workspace/);
  } finally {
    [env.zohoClientId, env.zohoClientSecret, env.salesforceClientId, env.salesforceClientSecret] = old;
  }
});

test("Zoho rejects untrusted API domains before storing OAuth tokens", async () => {
  const old = [env.zohoClientId, env.zohoClientSecret];
  const originalFetch = globalThis.fetch;
  env.zohoClientId = "zoho-client";
  env.zohoClientSecret = "zoho-secret";
  try {
    const state = new URL(crmOAuthUrl("org-1", "zoho")).searchParams.get("state")!;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://accounts.zoho.com/oauth/v2/token");
      return new Response(JSON.stringify({ access_token: "token", refresh_token: "refresh", api_domain: "https://evil.example" }), { status: 200 });
    };
    await assert.rejects(completeCrmOAuth("org-1", "zoho", "code", state, "https://accounts.zoho.com"), /untrusted API address/);
    await assert.rejects(completeCrmOAuth("org-1", "zoho", "code", state, "https://accounts.evil.example"), /unrecognized account region/);
  } finally {
    globalThis.fetch = originalFetch;
    [env.zohoClientId, env.zohoClientSecret] = old;
  }
});

test("Zoho saves a verified, encrypted workspace connection", async () => {
  const old = [env.zohoClientId, env.zohoClientSecret];
  const originalFetch = globalThis.fetch;
  const originalUpdate = ProviderIntegrationModel.findOneAndUpdate;
  let saved: Record<string, unknown> | undefined;
  env.zohoClientId = "zoho-client";
  env.zohoClientSecret = "zoho-secret";
  try {
    const state = new URL(crmOAuthUrl("org-1", "zoho")).searchParams.get("state")!;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://accounts.zoho.com/oauth/v2/token") return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", api_domain: "https://www.zohoapis.com" }), { status: 200 });
      if (url === "https://www.zohoapis.com/crm/v8/users?type=CurrentUser") return new Response(JSON.stringify({ users: [{ email: "owner@example.com" }] }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    (ProviderIntegrationModel as unknown as { findOneAndUpdate: (...args: unknown[]) => Promise<void> }).findOneAndUpdate = async (_query, value) => { saved = value as Record<string, unknown>; };
    await completeCrmOAuth("org-1", "zoho", "code", state, "https://accounts.zoho.com");
    assert.equal(saved?.ownerId, "org-1");
    assert.equal(saved?.accountId, "owner@example.com");
    assert.notEqual(saved?.secretEncrypted, "refresh");
    assert.equal(JSON.parse(decryptSecret(String(saved?.secretEncrypted))).refreshToken, "refresh");
  } finally {
    globalThis.fetch = originalFetch;
    ProviderIntegrationModel.findOneAndUpdate = originalUpdate;
    [env.zohoClientId, env.zohoClientSecret] = old;
  }
});

test("Salesforce sandbox OAuth verifies the user and rejects untrusted instances", async () => {
  const old = [env.salesforceClientId, env.salesforceClientSecret];
  const originalFetch = globalThis.fetch;
  const originalUpdate = ProviderIntegrationModel.findOneAndUpdate;
  let saved: Record<string, unknown> | undefined;
  env.salesforceClientId = "salesforce-client";
  env.salesforceClientSecret = "salesforce-secret";
  try {
    const state = new URL(crmOAuthUrl("org-1", "salesforce", true)).searchParams.get("state")!;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://test.salesforce.com/services/oauth2/token") return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", instance_url: "https://customer.my.salesforce.com" }), { status: 200 });
      if (url === "https://customer.my.salesforce.com/services/oauth2/userinfo") return new Response(JSON.stringify({ email: "owner@example.com" }), { status: 200 });
      throw new Error(`Unexpected URL ${url}`);
    };
    (ProviderIntegrationModel as unknown as { findOneAndUpdate: (...args: unknown[]) => Promise<void> }).findOneAndUpdate = async (_query, value) => { saved = value as Record<string, unknown>; };
    await completeCrmOAuth("org-1", "salesforce", "code", state);
    assert.equal(saved?.accountId, "owner@example.com");
    assert.equal(JSON.parse(decryptSecret(String(saved?.secretEncrypted))).apiBase, "https://customer.my.salesforce.com");

    globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", instance_url: "https://evil.example" }), { status: 200 });
    await assert.rejects(completeCrmOAuth("org-1", "salesforce", "code", state), /untrusted API address/);
  } finally {
    globalThis.fetch = originalFetch;
    ProviderIntegrationModel.findOneAndUpdate = originalUpdate;
    [env.salesforceClientId, env.salesforceClientSecret] = old;
  }
});
