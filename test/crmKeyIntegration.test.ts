import assert from "node:assert/strict";
import test from "node:test";

import { freshsalesFilters, freshsalesSite, highLevelContacts, highLevelLocation } from "../src/services/crmKeyIntegrationService.js";

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

test("HighLevel verifies a private token against the selected location", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://services.leadconnectorhq.com/locations/location-123");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer pit-token");
    assert.equal(headers.get("Version"), "2021-07-28");
    return new Response(JSON.stringify({ location: { id: "location-123", name: "Main Location" } }), { status: 200 });
  };
  try {
    assert.deepEqual(await highLevelLocation({ locationId: "location-123", token: "pit-token" }), {
      locationId: "location-123",
      name: "Main Location",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HighLevel contact preview is scoped to the saved location", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://services.leadconnectorhq.com/contacts/");
    assert.equal(url.searchParams.get("locationId"), "location-123");
    assert.equal(url.searchParams.get("limit"), "5");
    return new Response(JSON.stringify({ contacts: [{ id: "contact-1", name: "Asha Shah" }] }), { status: 200 });
  };
  try {
    assert.deepEqual(await highLevelContacts({ locationId: "location-123", token: "pit-token" }), {
      items: [{ id: "contact-1", name: "Asha Shah", type: "contact" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
