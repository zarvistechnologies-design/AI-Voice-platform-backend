import assert from "node:assert/strict";
import test, { after } from "node:test";

import { env } from "../src/config/env.js";
import { razorpayOAuthUrl, completeRazorpayOAuth } from "../src/services/razorpayOAuthService.js";
import { closeDashboardCache } from "../src/services/dashboardCacheService.js";
import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { decryptSecret } from "../src/utils/secretCrypto.js";

after(closeDashboardCache);

test("Razorpay partner OAuth requests read-only merchant access", async () => {
  const old = [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret];
  env.razorpayOAuthTestClientId = "partner-client";
  env.razorpayOAuthTestClientSecret = "partner-secret";
  try {
    const url = new URL(razorpayOAuthUrl("org-1", "test"));
    assert.equal(url.origin, "https://auth.razorpay.com");
    assert.equal(url.searchParams.get("scope"), "read_only");
    await assert.rejects(completeRazorpayOAuth("org-2", "code", url.searchParams.get("state")!), /another workspace/);
  } finally {
    [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret] = old;
  }
});

test("Razorpay partner OAuth exchanges a code using its documented grant and rejects incomplete tokens", async () => {
  const old = [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret];
  const originalFetch = globalThis.fetch;
  env.razorpayOAuthTestClientId = "partner-client";
  env.razorpayOAuthTestClientSecret = "partner-secret";
  try {
    const state = new URL(razorpayOAuthUrl("org-1", "test")).searchParams.get("state")!;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://auth.razorpay.com/token");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.grant_type, "authorisation_code");
      assert.equal(body.mode, "test");
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    };
    await assert.rejects(completeRazorpayOAuth("org-1", "code", state), /persistent merchant access/);
  } finally {
    globalThis.fetch = originalFetch;
    [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret] = old;
  }
});

test("Razorpay partner OAuth verifies payments and encrypts merchant tokens", async () => {
  const old = [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret];
  const originalFetch = globalThis.fetch;
  const originalUpdate = ProviderIntegrationModel.findOneAndUpdate;
  let saved: Record<string, unknown> | undefined;
  env.razorpayOAuthTestClientId = "partner-client";
  env.razorpayOAuthTestClientSecret = "partner-secret";
  try {
    const state = new URL(razorpayOAuthUrl("org-1", "test")).searchParams.get("state")!;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.razorpay.com/token") return new Response(JSON.stringify({ access_token: "merchant-access", refresh_token: "merchant-refresh", razorpay_account_id: "acc_1", expires_in: 3600 }), { status: 200 });
      if (url === "https://api.razorpay.com/v1/payments?count=5") {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer merchant-access");
        return new Response(JSON.stringify({ items: [{ id: "pay_1", amount: 200, currency: "INR", status: "captured" }] }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    (ProviderIntegrationModel as unknown as { findOneAndUpdate: (...args: unknown[]) => Promise<void> }).findOneAndUpdate = async (_query, value) => { saved = value as Record<string, unknown>; };
    await completeRazorpayOAuth("org-1", "code", state);
    assert.equal(saved?.ownerId, "org-1");
    assert.equal(saved?.accountId, "acc_1");
    assert.equal(JSON.parse(decryptSecret(String(saved?.secretEncrypted))).refreshToken, "merchant-refresh");
  } finally {
    globalThis.fetch = originalFetch;
    ProviderIntegrationModel.findOneAndUpdate = originalUpdate;
    [env.razorpayOAuthTestClientId, env.razorpayOAuthTestClientSecret] = old;
  }
});
