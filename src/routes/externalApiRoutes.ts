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
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireApiScope, requireAuth, requireRole } from "../middleware/auth.js";

export const externalApiRouter = Router();

externalApiRouter.use(requireAuth);
externalApiRouter.get("/agents", requireApiScope("read"), asyncHandler(listAgents));
externalApiRouter.get("/calls", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/call-logs", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/calls/stream", requireApiScope("read"), asyncHandler(streamCallEvents));
externalApiRouter.get("/calls/export.csv", requireApiScope("read"), asyncHandler(exportCallsCsv));
externalApiRouter.post(
  "/calls/outbound",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(createOutboundCall),
);
externalApiRouter.post(
  "/outbound-calls",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(createOutboundCall),
);
externalApiRouter.get("/calls/:callId/recording", requireApiScope("read"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId/recording-file", requireApiScope("read"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId", requireApiScope("read"), asyncHandler(getExternalCall));
externalApiRouter.get("/call-logs/:callId", requireApiScope("read"), asyncHandler(getExternalCall));

// Campaigns & Batch Calling
externalApiRouter.get("/campaigns", requireApiScope("read"), asyncHandler(listCampaigns));
externalApiRouter.post(
  "/campaigns",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(createCampaign),
);
externalApiRouter.get("/campaigns/:campaignId", requireApiScope("read"), asyncHandler(getCampaign));
externalApiRouter.get("/campaigns/:campaignId/results", requireApiScope("read"), asyncHandler(getCampaignResults));
externalApiRouter.get("/campaigns/:campaignId/results.csv", requireApiScope("read"), asyncHandler(exportCampaignResultsCsv));
externalApiRouter.get("/campaigns/:campaignId/leads", requireApiScope("read"), asyncHandler(listCampaignLeads));
externalApiRouter.patch("/campaigns/:campaignId/leads/:leadId/outcome", requireApiScope("calls:trigger"), asyncHandler(reviewCampaignLeadOutcome));
externalApiRouter.post("/campaigns/:campaignId/leads/:leadId/conversions", requireApiScope("calls:trigger"), asyncHandler(recordCampaignLeadConversion));
externalApiRouter.put("/campaigns/:campaignId/scorecard", requireApiScope("calls:trigger"), asyncHandler(updateCampaignScorecard));
externalApiRouter.post("/campaigns/:campaignId/reanalyze", requireApiScope("calls:trigger"), asyncHandler(reanalyzeCampaign));
externalApiRouter.post(
  "/campaigns/:campaignId/leads",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(addCampaignLeads),
);
externalApiRouter.post(
  "/campaigns/:campaignId/launch",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(launchCampaign),
);
externalApiRouter.post(
  "/campaigns/:campaignId/pause",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(pauseCampaign),
);
externalApiRouter.post(
  "/campaigns/:campaignId/resume",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(resumeCampaign),
);

// Telephony Phone Numbers
externalApiRouter.get("/phone-numbers", requireApiScope("read"), asyncHandler(listPhoneNumbers));

// Knowledge Bases & RAG
externalApiRouter.get("/knowledge-bases", requireApiScope("read"), asyncHandler(listWorkspaceKnowledge));
externalApiRouter.get("/knowledge", requireApiScope("read"), asyncHandler(listWorkspaceKnowledge));

