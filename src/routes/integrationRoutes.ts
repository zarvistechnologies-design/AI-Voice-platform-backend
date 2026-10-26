import { Router } from "express";

import {
  attachDigitalBotTools,
  connectDigitalBot,
  connectIntegration,
  disconnectDigitalBot,
  disconnectIntegration,
  listIntegrations,
  setDigitalBotToolsState,
  startGoogleOAuth,
  verifyDigitalBot,
  googleOAuthCallback,
  removeGoogleConnection,
  googleCalendars,
  googleSpreadsheet,
  createSpreadsheet,
  testGoogleCalendar,
  testGoogleSheet,
} from "../controllers/integrationController.js";
import {
  disconnectWhatsApp,
  getWhatsAppStatus,
  handleEmbeddedSignup,
  sendWhatsAppTestMessage,
} from "../controllers/whatsappController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  requireWhiteLabelFeature,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";

export const integrationRouter = Router();

integrationRouter.use(requireAuth);
integrationRouter.use(requireWhiteLabelSubscription, requireWhiteLabelFeature("integrations"));
integrationRouter.get("/", asyncHandler(listIntegrations));
integrationRouter.post("/digitalbot/connections", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectDigitalBot));
integrationRouter.post("/digitalbot/connections/:agentId/verify", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(verifyDigitalBot));
integrationRouter.delete("/digitalbot/connections/:agentId", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectDigitalBot));
integrationRouter.put("/digitalbot/connections/:agentId/tools", requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(setDigitalBotToolsState));
integrationRouter.put("/digitalbot", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectDigitalBot));
integrationRouter.post("/digitalbot/verify", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(verifyDigitalBot));
integrationRouter.post("/digitalbot/attach-tools", requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(attachDigitalBotTools));
integrationRouter.delete("/digitalbot", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectDigitalBot));
integrationRouter.get("/google/oauth/start", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(startGoogleOAuth));
integrationRouter.get("/google/callback", asyncHandler(googleOAuthCallback));
integrationRouter.delete("/google", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(removeGoogleConnection));
integrationRouter.get("/google/calendars", asyncHandler(googleCalendars));
integrationRouter.post("/google/spreadsheet", requireWhiteLabelWriteAccess, asyncHandler(googleSpreadsheet));
integrationRouter.post("/google/spreadsheet/create", requireWhiteLabelWriteAccess, asyncHandler(createSpreadsheet));
integrationRouter.post("/google/calendar/test", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(testGoogleCalendar));
integrationRouter.post("/google/sheets/test", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(testGoogleSheet));

// WhatsApp Integration Routes
integrationRouter.post("/whatsapp/embedded-signup", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(handleEmbeddedSignup));
integrationRouter.get("/whatsapp/status", asyncHandler(getWhatsAppStatus));
integrationRouter.post("/whatsapp/test-message", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(sendWhatsAppTestMessage));
integrationRouter.delete("/whatsapp", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectWhatsApp));

integrationRouter.put("/:provider", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectIntegration));
integrationRouter.delete("/:provider", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectIntegration));
