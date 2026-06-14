import { Router } from "express";

import {
  createAgent,
  browseVobizInventory,
  connectVobizAccount,
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
  syncPhoneNumbers,
  updateAgent,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const voiceRouter = Router();

voiceRouter.use(requireAuth);
voiceRouter.get("/config", asyncHandler(getVoiceConfig));
voiceRouter.get("/agents", asyncHandler(listAgents));
voiceRouter.post("/agents", asyncHandler(createAgent));
voiceRouter.put("/agents/:agentId", asyncHandler(updateAgent));
voiceRouter.post("/web-call-token", asyncHandler(createWebToken));
voiceRouter.post("/outbound-calls", asyncHandler(createOutboundCall));
voiceRouter.get("/phone-numbers", asyncHandler(listPhoneNumbers));
voiceRouter.get("/vobiz/numbers", asyncHandler(listVobizAccountNumbers));
voiceRouter.get("/vobiz/inventory", asyncHandler(browseVobizInventory));
voiceRouter.get("/integrations/vobiz", asyncHandler(getVobizConnection));
voiceRouter.put("/integrations/vobiz", asyncHandler(connectVobizAccount));
voiceRouter.delete("/integrations/vobiz", asyncHandler(disconnectVobizAccount));
voiceRouter.post("/phone-numbers/import", asyncHandler(importPhoneNumber));
voiceRouter.post("/phone-numbers/purchase", asyncHandler(purchasePhoneNumber));
voiceRouter.post("/phone-numbers/sync", asyncHandler(syncPhoneNumbers));
