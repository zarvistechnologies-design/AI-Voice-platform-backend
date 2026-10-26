import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Response } from "express";

import { setAgentIntegrationAccess } from "../src/controllers/integrationController.js";
import type { AuthenticatedRequest } from "../src/middleware/auth.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { closeDashboardCache } from "../src/services/dashboardCacheService.js";

after(closeDashboardCache);

test("voice agent integration access requires a connected provider and granted Google scope", async () => {
  const originalAgentFind = VoiceAgentModel.findOne;
  const originalProviderFind = ProviderIntegrationModel.findOne;
  const agent = {
    id: "agent-1", version: 1, integrationReadProviders: [] as string[],
    set(_path: string, value: string[]) { this.integrationReadProviders = value; },
    async save() { return this; },
  };
  let provider: { metadata?: Record<string, unknown> } | null = null;
  (VoiceAgentModel as unknown as { findOne: (...args: unknown[]) => Promise<typeof agent> }).findOne = async () => agent;
  (ProviderIntegrationModel as unknown as { findOne: (...args: unknown[]) => unknown }).findOne = () => ({ select: () => ({ lean: async () => provider }) });
  const request = {
    organization: { id: "org-1" }, params: { agentId: "agent-1" }, body: { provider: "asana", enabled: true },
  } as unknown as AuthenticatedRequest;
  let result: unknown;
  const response = { json(value: unknown) { result = value; } } as unknown as Response;
  try {
    await assert.rejects(setAgentIntegrationAccess(request, response), /Connect this integration/);
    provider = { metadata: {} };
    request.body.provider = "google_gmail";
    await assert.rejects(setAgentIntegrationAccess(request, response), /Authorize this Google feature/);
    request.body.provider = "asana";
    await setAgentIntegrationAccess(request, response);
    assert.deepEqual(agent.integrationReadProviders, ["asana"]);
    assert.deepEqual(result, { id: "agent-1", providers: ["asana"] });
  } finally {
    VoiceAgentModel.findOne = originalAgentFind;
    ProviderIntegrationModel.findOne = originalProviderFind;
  }
});
