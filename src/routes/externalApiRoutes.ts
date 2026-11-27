import { Router } from "express";

import {
  exportCallsCsv,
  getExternalCall,
  listExternalCalls,
  streamCallEvents,
  streamCallRecordingFile,
} from "../controllers/callController.js";
import {
  addCampaignLeads,
  createCampaign,
  exportCampaignResultsCsv,
  getCampaign,
  getCampaignResults,
  launchCampaign,
  listCampaignLeads,
  listCampaigns,
  reviewCampaignLeadOutcome,
  recordCampaignLeadConversion,
  reanalyzeCampaign,
  updateCampaignScorecard,
  pauseCampaign,
  resumeCampaign,
} from "../controllers/campaignController.js";
import { listWorkspaceKnowledge } from "../controllers/knowledgeController.js";
import {
  createOutboundCall,
  listAgents,
  listPhoneNumbers,
  listNativeAppointments,
  listNativeWorkflowResults,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireApiScope, requireAuth, requireRole } from "../middleware/auth.js";
import { resolveConnectedDigitalBotWorkspace } from "../middleware/digitalBotWorkspaceAccess.js";
import {
  requireWhiteLabelCallCapacity,
  requireWhiteLabelFeature,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";

export const externalApiRouter = Router();

externalApiRouter.use(requireAuth);
externalApiRouter.use(resolveConnectedDigitalBotWorkspace);
externalApiRouter.use(requireWhiteLabelSubscription, requireWhiteLabelFeature("developerApi"));
externalApiRouter.get("/agents", requireApiScope("read"), asyncHandler(listAgents));
externalApiRouter.get("/agents/:agentId/appointments", requireApiScope("read"), asyncHandler(listNativeAppointments));
externalApiRouter.get("/agents/:agentId/native-results", requireApiScope("read"), asyncHandler(listNativeWorkflowResults));
externalApiRouter.get("/calls", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/call-logs", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/calls/stream", requireApiScope("read"), asyncHandler(streamCallEvents));
externalApiRouter.get("/calls/export.csv", requireApiScope("read"), asyncHandler(exportCallsCsv));
externalApiRouter.post(
  "/calls/outbound",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelFeature("outboundCalling"),
  requireWhiteLabelCallCapacity,
  asyncHandler(createOutboundCall),
);
externalApiRouter.post(
  "/outbound-calls",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelFeature("outboundCalling"),
  requireWhiteLabelCallCapacity,
  asyncHandler(createOutboundCall),
);
externalApiRouter.get("/calls/:callId/recording", requireApiScope("read"), requireWhiteLabelFeature("callRecording"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId/recording-file", requireApiScope("read"), requireWhiteLabelFeature("callRecording"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId", requireApiScope("read"), asyncHandler(getExternalCall));
externalApiRouter.get("/call-logs/:callId", requireApiScope("read"), asyncHandler(getExternalCall));

// Campaigns & Batch Calling
externalApiRouter.get("/campaigns", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(listCampaigns));
externalApiRouter.post(
  "/campaigns",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelWriteAccess,
  requireWhiteLabelFeature("campaigns"),
  asyncHandler(createCampaign),
);
externalApiRouter.get("/campaigns/:campaignId", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(getCampaign));
externalApiRouter.get("/campaigns/:campaignId/results", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(getCampaignResults));
externalApiRouter.get("/campaigns/:campaignId/results.csv", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(exportCampaignResultsCsv));
externalApiRouter.get("/campaigns/:campaignId/leads", requireApiScope("read"), requireWhiteLabelFeature("campaigns"), asyncHandler(listCampaignLeads));
externalApiRouter.patch("/campaigns/:campaignId/leads/:leadId/outcome", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(reviewCampaignLeadOutcome));
externalApiRouter.post("/campaigns/:campaignId/leads/:leadId/conversions", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(recordCampaignLeadConversion));
externalApiRouter.put("/campaigns/:campaignId/scorecard", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(updateCampaignScorecard));
externalApiRouter.post("/campaigns/:campaignId/reanalyze", requireApiScope("calls:trigger"), requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, requireWhiteLabelFeature("campaigns"), asyncHandler(reanalyzeCampaign));
externalApiRouter.post(
  "/campaigns/:campaignId/leads",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelWriteAccess,
  requireWhiteLabelFeature("campaigns"),
  asyncHandler(addCampaignLeads),
);
externalApiRouter.post(
  "/campaigns/:campaignId/launch",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelFeature("campaigns"),
  requireWhiteLabelCallCapacity,
  asyncHandler(launchCampaign),
);
externalApiRouter.post(
  "/campaigns/:campaignId/pause",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelWriteAccess,
  requireWhiteLabelFeature("campaigns"),
  asyncHandler(pauseCampaign),
);
externalApiRouter.post(
  "/campaigns/:campaignId/resume",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  requireWhiteLabelFeature("campaigns"),
  requireWhiteLabelCallCapacity,
  asyncHandler(resumeCampaign),
);

// Telephony Phone Numbers
externalApiRouter.get("/phone-numbers", requireApiScope("read"), asyncHandler(listPhoneNumbers));

// Knowledge Bases & RAG
externalApiRouter.get("/knowledge-bases", requireApiScope("read"), requireWhiteLabelFeature("knowledgeBase"), asyncHandler(listWorkspaceKnowledge));
externalApiRouter.get("/knowledge", requireApiScope("read"), requireWhiteLabelFeature("knowledgeBase"), asyncHandler(listWorkspaceKnowledge));

