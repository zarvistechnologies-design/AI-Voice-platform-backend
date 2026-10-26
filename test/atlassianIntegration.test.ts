import assert from "node:assert/strict";
import test from "node:test";

import { atlassianSite, previewAtlassianProvider, verifyAtlassianProvider } from "../src/services/atlassianIntegrationService.js";

test("Atlassian connection accepts only Cloud sites", () => {
  assert.equal(atlassianSite("acme"), "https://acme.atlassian.net");
  assert.equal(atlassianSite("https://acme.atlassian.net"), "https://acme.atlassian.net");
  for (const site of ["http://127.0.0.1", "http://acme.atlassian.net", "https://acme.atlassian.net.evil.com", "https://user:pass@acme.atlassian.net"]) {
    assert.throws(() => atlassianSite(site), /Atlassian site/);
  }
});

test("Jira verifies its account and previews projects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith("https://acme.atlassian.net/rest/api/3/"));
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from("admin@example.com:example-token").toString("base64")}`);
    const data = url.endsWith("/myself")
      ? { accountId: "user-1", displayName: "Admin" }
      : { values: [{ id: "project-1", name: "Support" }] };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    const credentials = { site: "acme", email: "admin@example.com", token: "example-token" };
    assert.deepEqual(await verifyAtlassianProvider("jira", credentials), { accountId: "Admin", site: "https://acme.atlassian.net" });
    assert.deepEqual(await previewAtlassianProvider("jira", credentials), { items: [{ id: "project-1", name: "Support", type: "project" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Atlassian Confluence verifies its account and previews pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.ok(url.startsWith("https://acme.atlassian.net/wiki/"));
    const data = url.endsWith("/user/current")
      ? { accountId: "user-1", displayName: "Admin" }
      : { results: [{ id: "page-1", title: "Call guide" }] };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    const credentials = { site: "acme.atlassian.net", email: "admin@example.com", token: "example-token" };
    assert.deepEqual(await verifyAtlassianProvider("atlassian", credentials), { accountId: "Admin", site: "https://acme.atlassian.net" });
    assert.deepEqual(await previewAtlassianProvider("atlassian", credentials), { items: [{ id: "page-1", name: "Call guide", type: "page" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
