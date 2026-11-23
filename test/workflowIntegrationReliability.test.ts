import assert from "node:assert/strict";
import test from "node:test";

import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { syncLeadToConnectedCrms } from "../src/services/workflowIntegrationsService.js";
import { encryptSecret } from "../src/utils/secretCrypto.js";

const lead = { contactName: "Sample Lead", contactPhone: "+919876543210", stage: "New", tag: "workflow" };

test("Zoho record-level errors do not count as a successful CRM sync", async () => {
  const originalFind = ProviderIntegrationModel.find;
  const originalFindOne = ProviderIntegrationModel.findOne;
  const originalFetch = globalThis.fetch;
  const connection = {
    provider: "zoho",
    metadata: { workflowWriteAccess: true },
    secretEncrypted: encryptSecret(JSON.stringify({
      accessToken: "access", refreshToken: "refresh", apiBase: "https://www.zohoapis.com",
      authBase: "https://accounts.zoho.com", expiresAt: Date.now() + 60_000,
    })),
  };
  try {
    (ProviderIntegrationModel as unknown as { find: (...args: unknown[]) => unknown }).find = () => ({ select: async () => [connection] });
    (ProviderIntegrationModel as unknown as { findOne: (...args: unknown[]) => unknown }).findOne = () => ({ select: async () => connection });
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ status: "error", message: "Invalid Lead_Status" }] }), { status: 200 });
    const result = await syncLeadToConnectedCrms("workspace", { ...lead, provider: "zoho" });
    assert.deepEqual(result.syncedProviders, []);
    assert.match(result.errors[0] ?? "", /Invalid Lead_Status/);
  } finally {
    ProviderIntegrationModel.find = originalFind;
    ProviderIntegrationModel.findOne = originalFindOne;
    globalThis.fetch = originalFetch;
  }
});

test("Google Sheets sync reports missing spreadsheet configuration", async () => {
  const originalFind = ProviderIntegrationModel.find;
  try {
    (ProviderIntegrationModel as unknown as { find: (...args: unknown[]) => unknown }).find = () => ({ select: async () => [{ provider: "google", metadata: {} }] });
    const result = await syncLeadToConnectedCrms("workspace", { ...lead, provider: "google" });
    assert.deepEqual(result.syncedProviders, []);
    assert.match(result.errors[0] ?? "", /Spreadsheet ID/);
  } finally {
    ProviderIntegrationModel.find = originalFind;
  }
});
