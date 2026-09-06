import express, { Router } from "express";

import {
  createAgent,
  assignPhoneNumberAgent,
  browseVobizInventory,
  connectVobizAccount,
  createPhoneNumber,
  createOutboundCall,
  createPublicWidgetToken,
  createWebToken,
  deletePhoneNumber,
  getVoiceConfig,
  getDashboardBootstrap,
  getAgent,
  getAgentDashboard,
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
  previewMarketingVoice,
  testAgentTool,
  getAgentDispatchStatus,
  getPublicWidgetAgent,
  streamAgentRuntime,
  activateInboundPhoneNumber,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireApiScope, requireAuth, requireRole } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import {
  exportCallsCsv,
  getCall,
  getCallInvoice,
  listCalls,
  streamCallEvents,
  streamCallRecordingFile,
  uploadWebCallRecording,
} from "../controllers/callController.js";
import { analyticsOverview } from "../controllers/analyticsController.js";
import {
  addCampaignLeads,
  cancelCampaign,
  createCampaign,
  createSuppression,
  deleteSuppression,
  getCampaign,
  launchCampaign,
  listCampaignLeads,
  listCampaigns,
  listSuppressions,
  pauseCampaign,
  resumeCampaign,
} from "../controllers/campaignController.js";
import {
  addFileKnowledgeSource,
  addTextKnowledgeSource,
  addUrlKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
  removeKnowledgeSource,
  testKnowledgeSearch,
  updateKnowledgeSource,
} from "../controllers/knowledgeController.js";
import { knowledgeFileUpload } from "../middleware/knowledgeUpload.js";
import {
  enforceWhiteLabelAgentSettings,
  requireWhiteLabelCallCapacity,
  requireWhiteLabelFeature,
  requireWhiteLabelResourceCapacity,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";

export const voiceRouter = Router();

voiceRouter.get("/marketing-preview/:languageCode", asyncHandler(previewMarketingVoice));

const publicCallTokenLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many call attempts. Try again shortly.",
});

voiceRouter.get("/widget/agents/:agentId", asyncHandler(getPublicWidgetAgent));
voiceRouter.post("/widget/call-token", publicCallTokenLimit, asyncHandler(createPublicWidgetToken));

voiceRouter.use(requireAuth);
voiceRouter.use(requireWhiteLabelSubscription);
voiceRouter.get("/bootstrap", requireApiScope("read"), asyncHandler(getDashboardBootstrap));
voiceRouter.get("/config", requireApiScope("read"), asyncHandler(getVoiceConfig));
voiceRouter.get("/agents", requireApiScope("read"), asyncHandler(listAgents));
voiceRouter.get("/agents/:agentId/dashboard", requireApiScope("read"), asyncHandler(getAgentDashboard));
voiceRouter.get("/agents/:agentId", requireApiScope("read"), asyncHandler(getAgent));
voiceRouter.get("/agent-templates", requireApiScope("read"), asyncHandler(listAgentTemplates));
voiceRouter.get("/calls", requireApiScope("read"), asyncHandler(listCalls));
voiceRouter.get("/calls/export.csv", requireApiScope("read"), asyncHandler(exportCallsCsv));
voiceRouter.get("/calls/stream", requireApiScope("read"), asyncHandler(streamCallEvents));
voiceRouter.get("/calls/:callId/invoice", requireApiScope("read"), asyncHandler(getCallInvoice));
voiceRouter.get("/calls/:callId/recording-file", requireApiScope("read"), requireWhiteLabelFeature("callRecording"), asyncHandler(streamCallRecordingFile));
voiceRouter.post(
  "/calls/:callId/recording",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelWriteAccess,
  requireWhiteLabelFeature("callRecording"),
  express.raw({
    limit: "100mb",
    type: ["audio/webm", "video/webm", "audio/mp4", "video/mp4", "audio/mpeg", "audio/ogg", "application/ogg", "application/octet-stream"],
  }),
  asyncHandler(uploadWebCallRecording),
);
voiceRouter.get("/calls/:callId", requireApiScope("read"), asyncHandler(getCall));
voiceRouter.get("/analytics/overview", requireApiScope("read"), requireWhiteLabelFeature("advancedAnalytics"), asyncHandler(analyticsOverview));
voiceRouter.get("/agent-dispatch-status", requireApiScope("read"), asyncHandler(getAgentDispatchStatus));
voiceRouter.get("/agents/:agentId/runtime/stream", requireApiScope("read"), asyncHandler(streamAgentRuntime));
voiceRouter.post("/agents", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("agents"), enforceWhiteLabelAgentSettings, asyncHandler(createAgent));
voiceRouter.post("/agent-templates/:templateId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("agents"), enforceWhiteLabelAgentSettings, asyncHandler(createAgentFromTemplate));
voiceRouter.post("/voice-preview", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(previewVoice));
voiceRouter.put("/agents/:agentId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, enforceWhiteLabelAgentSettings, asyncHandler(updateAgent));
voiceRouter.post("/agents/:agentId/tools/test", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(testAgentTool));
voiceRouter.get("/agents/:agentId/knowledge", requireApiScope("read"), requireWhiteLabelFeature("knowledgeBase"), asyncHandler(listKnowledgeSources));
voiceRouter.get("/agents/:agentId/knowledge/:sourceId", requireApiScope("read"), requireWhiteLabelFeature("knowledgeBase"), asyncHandler(getKnowledgeSource));
voiceRouter.post("/agents/:agentId/knowledge/search", requireApiScope("read"), requireWhiteLabelFeature("knowledgeBase"), asyncHandler(testKnowledgeSearch));
voiceRouter.post("/agents/:agentId/knowledge/text", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), requireWhiteLabelResourceCapacity("knowledgeSources"), asyncHandler(addTextKnowledgeSource));
voiceRouter.post("/agents/:agentId/knowledge/url", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), requireWhiteLabelResourceCapacity("knowledgeSources"), asyncHandler(addUrlKnowledgeSource));
voiceRouter.post("/agents/:agentId/knowledge/file", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), requireWhiteLabelResourceCapacity("knowledgeSources"), knowledgeFileUpload, asyncHandler(addFileKnowledgeSource));
voiceRouter.put("/agents/:agentId/knowledge/:sourceId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), asyncHandler(updateKnowledgeSource));
voiceRouter.post("/agents/:agentId/knowledge/:sourceId/reindex", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), asyncHandler(reindexKnowledgeSource));
voiceRouter.delete("/agents/:agentId/knowledge/:sourceId", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("knowledgeBase"), asyncHandler(removeKnowledgeSource));
voiceRouter.post("/agents/:agentId/clone", requireApiScope("agents:write"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("agents"), asyncHandler(cloneAgent));
voiceRouter.delete("/agents/:agentId", requireApiScope("agents:write"), requireRole("owner", "admin"), asyncHandler(deleteAgent));
voiceRouter.post("/web-call-token", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelFeature("outboundCalling"), requireWhiteLabelCallCapacity, asyncHandler(createWebToken));
voiceRouter.post("/outbound-calls", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelFeature("outboundCalling"), requireWhiteLabelCallCapacity, asyncHandler(createOutboundCall));
voiceRouter.get("/campaigns", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(listCampaigns));
voiceRouter.post("/campaigns", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(createCampaign));
voiceRouter.get("/campaigns/:campaignId", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(getCampaign));
voiceRouter.get("/campaigns/:campaignId/leads", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(listCampaignLeads));
voiceRouter.post("/campaigns/:campaignId/leads", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(addCampaignLeads));
voiceRouter.post("/campaigns/:campaignId/launch", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelFeature("campaigns"), requireWhiteLabelCallCapacity, asyncHandler(launchCampaign));
voiceRouter.post("/campaigns/:campaignId/pause", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(pauseCampaign));
voiceRouter.post("/campaigns/:campaignId/resume", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelFeature("campaigns"), requireWhiteLabelCallCapacity, asyncHandler(resumeCampaign));
voiceRouter.post("/campaigns/:campaignId/cancel", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(cancelCampaign));
voiceRouter.get("/campaign-suppressions", requireApiScope("read"), asyncHandler(listSuppressions));
voiceRouter.post("/campaign-suppressions", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), asyncHandler(createSuppression));
voiceRouter.delete("/campaign-suppressions/:suppressionId", requireApiScope("calls:trigger"), requireRole("owner", "admin"), asyncHandler(deleteSuppression));
voiceRouter.get("/phone-numbers", requireApiScope("read"), asyncHandler(listPhoneNumbers));
voiceRouter.post("/phone-numbers", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("phoneNumbers"), asyncHandler(createPhoneNumber));
voiceRouter.put("/phone-numbers/:phoneNumberId/agent", requireRole("owner", "admin"), asyncHandler(assignPhoneNumberAgent));
voiceRouter.delete("/phone-numbers/:phoneNumberId", requireRole("owner", "admin"), asyncHandler(deletePhoneNumber));
voiceRouter.get("/vobiz/numbers", requireApiScope("read"), asyncHandler(listVobizAccountNumbers));
voiceRouter.get("/vobiz/inventory", requireApiScope("read"), asyncHandler(browseVobizInventory));
voiceRouter.get("/integrations/vobiz", requireApiScope("read"), asyncHandler(getVobizConnection));
voiceRouter.put("/integrations/vobiz", requireRole("owner", "admin"), asyncHandler(connectVobizAccount));
voiceRouter.delete("/integrations/vobiz", requireRole("owner", "admin"), asyncHandler(disconnectVobizAccount));
voiceRouter.post("/phone-numbers/import", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("phoneNumbers"), asyncHandler(importPhoneNumber));
voiceRouter.post("/phone-numbers/purchase", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("phoneNumbers"), asyncHandler(purchasePhoneNumber));
voiceRouter.post("/phone-numbers/:phoneNumberId/activate-inbound", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("inboundCalling"), asyncHandler(activateInboundPhoneNumber));
voiceRouter.post("/phone-numbers/sync", requireRole("owner", "admin"), asyncHandler(syncPhoneNumbers));
