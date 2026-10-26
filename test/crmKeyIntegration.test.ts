import assert from "node:assert/strict";
import test from "node:test";

import { freshsalesFilters, freshsalesSite, prospeoAccount } from "../src/services/crmKeyIntegrationService.js";

test("Freshsales only accepts its hosted CRM domains", () => {
  assert.equal(freshsalesSite("acme"), "https://acme.myfreshworks.com");
  assert.equal(freshsalesSite("acme.myfreshworks.com"), "https://acme.myfreshworks.com");
  assert.throws(() => freshsalesSite("https://acme.myfreshworks.com.evil.com"), /Freshsales site/);
  assert.throws(() => freshsalesSite("http://acme.myfreshworks.com"), /Freshsales site/);
});

test("Freshsales verifies a key by reading contact views", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://acme.myfreshworks.com/crm/sales/api/contacts/filters");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Token token=example-key");
    return new Response(JSON.stringify({ filters: [{ id: 1, name: "All Contacts" }] }), { status: 200 });
  };
  try {
    assert.deepEqual(await freshsalesFilters({ site: "acme", apiKey: "example-key" }), {
      site: "https://acme.myfreshworks.com",
      items: [{ id: "1", name: "All Contacts", type: "contact view" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Prospeo checks account information without spending credits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.prospeo.io/account-information");
    assert.equal(new Headers(init?.headers).get("X-KEY"), "example-key");
    assert.ok(!init?.method || init.method === "GET");
    return new Response(JSON.stringify({ error: false, response: { current_plan: "STARTER", remaining_credits: 99 } }), { status: 200 });
  };
  try {
    assert.deepEqual(await prospeoAccount("example-key"), { plan: "STARTER", remainingCredits: 99 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
