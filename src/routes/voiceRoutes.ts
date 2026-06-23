import { Router } from "express";

import {
  createAgent,
  assignPhoneNumberAgent,
  browseVobizInventory,
  connectVobizAccount,
  createPhoneNumber,
  createOutboundCall,
  createWebToken,
  getVoiceConfig,
  getVobizConnection,
  importPhoneNumber,
  listAgents,
  listPhoneNumbers,
  listVobizAccountNumbers,
  purchasePhoneNumber,
  disconnectVobizAccount,
  cloneAgent,
  deleteAgent,
  syncPhoneNumbers,
  updateAgent,
  listAgentTemplates,
  createAgentFromTemplate,
  previewVoice,
  testAgentTool,
  getAgentDispatchStatus,
  streamAgentRuntime,
  activateInboundPhoneNumber,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireApiScope, requireAuth, requireRole } from "../middleware/auth.js";
import { exportCallsCsv, getCall, getCallInvoice, listCalls } from "../controllers/callController.js";
import { analyticsOverview } from "../controllers/analyticsController.js";

export const voiceRouter = Router();

voiceRouter.use(requireAuth);
voiceRouter.get("/config", requireApiScope("read"), asyncHandler(getVoiceConfig));
voiceRouter.get("/agents", requireApiScope("read"), asyncHandler(listAgents));
voiceRouter.get("/agent-templates", requireApiScope("read"), asyncHandler(listAgentTemplates));
voiceRouter.get("/calls", requireApiScope("read"), asyncHandler(listCalls));
voiceRouter.get("/calls/export.csv", requireApiScope("read"), asyncHandler(exportCallsCsv));
voiceRouter.get("/calls/:callId/invoice", requireApiScope("read"), asyncHandler(getCallInvoice));
voiceRouter.get("/calls/:callId", requireApiScope("read"), asyncHandler(getCall));
voiceRouter.get("/analytics/overview", requireApiScope("read"), asyncHandler(analyticsOverview));
voiceRouter.get("/agent-dispatch-status", requireApiScope("read"), asyncHandler(getAgentDispatchStatus));
voiceRouter.get("/agents/:agentId/runtime/stream", requireApiScope("read"), asyncHandler(streamAgentRuntime));
voiceRouter.post("/agents", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(createAgent));
voiceRouter.post("/agent-templates/:templateId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(createAgentFromTemplate));
voiceRouter.post("/voice-preview", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(previewVoice));
voiceRouter.put("/agents/:agentId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(updateAgent));
voiceRouter.post("/agents/:agentId/tools/test", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(testAgentTool));
voiceRouter.post("/agents/:agentId/clone", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), asyncHandler(cloneAgent));
voiceRouter.delete("/agents/:agentId", requireApiScope("agents:write"), requireRole("owner", "admin"), asyncHandler(deleteAgent));
voiceRouter.post("/web-call-token", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), asyncHandler(createWebToken));
voiceRouter.post("/outbound-calls", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), asyncHandler(createOutboundCall));
voiceRouter.get("/phone-numbers", requireApiScope("read"), asyncHandler(listPhoneNumbers));
voiceRouter.post("/phone-numbers", requireRole("owner", "admin"), asyncHandler(createPhoneNumber));
voiceRouter.put("/phone-numbers/:phoneNumberId/agent", requireRole("owner", "admin"), asyncHandler(assignPhoneNumberAgent));
voiceRouter.get("/vobiz/numbers", requireApiScope("read"), asyncHandler(listVobizAccountNumbers));
voiceRouter.get("/vobiz/inventory", requireApiScope("read"), asyncHandler(browseVobizInventory));
voiceRouter.get("/integrations/vobiz", requireApiScope("read"), asyncHandler(getVobizConnection));
voiceRouter.put("/integrations/vobiz", requireRole("owner", "admin"), asyncHandler(connectVobizAccount));
voiceRouter.delete("/integrations/vobiz", requireRole("owner", "admin"), asyncHandler(disconnectVobizAccount));
voiceRouter.post("/phone-numbers/import", requireRole("owner", "admin"), asyncHandler(importPhoneNumber));
voiceRouter.post("/phone-numbers/purchase", requireRole("owner", "admin"), asyncHandler(purchasePhoneNumber));
voiceRouter.post("/phone-numbers/:phoneNumberId/activate-inbound", requireRole("owner", "admin"), asyncHandler(activateInboundPhoneNumber));
voiceRouter.post("/phone-numbers/sync", requireRole("owner", "admin"), asyncHandler(syncPhoneNumbers));
