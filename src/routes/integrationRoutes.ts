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
  startCrmOAuth,
  crmOAuthCallback,
  crmOAuthPreview,
  removeCrmOAuth,
  startRazorpayOAuth,
  razorpayOAuthCallback,
  razorpayOAuthPreview,
  removeRazorpayOAuth,
  listAgentIntegrationAccess,
  setAgentIntegrationAccess,
  verifyDigitalBot,
  googleOAuthCallback,
  removeGoogleConnection,
  googleCalendars,
  googleDrivePreview,
  googleDocsPreview,
  gmailPreview,
  googleSpreadsheet,
  createSpreadsheet,
  testGoogleCalendar,
  testGoogleSheet,
  razorpayPayments,
  tokenProviderPreview,
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
integrationRouter.get("/agent-access", requireRole("owner", "admin"), asyncHandler(listAgentIntegrationAccess));
integrationRouter.put("/agent-access/:agentId", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(setAgentIntegrationAccess));
integrationRouter.post("/digitalbot/connections", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectDigitalBot));
integrationRouter.post("/digitalbot/connections/:agentId/verify", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(verifyDigitalBot));
integrationRouter.delete("/digitalbot/connections/:agentId", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectDigitalBot));
integrationRouter.put("/digitalbot/connections/:agentId/tools", requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(setDigitalBotToolsState));
integrationRouter.put("/digitalbot", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectDigitalBot));
integrationRouter.post("/digitalbot/verify", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(verifyDigitalBot));
integrationRouter.post("/digitalbot/attach-tools", requireRole("owner", "admin", "member"), requireWhiteLabelWriteAccess, asyncHandler(attachDigitalBotTools));
integrationRouter.delete("/digitalbot", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectDigitalBot));
integrationRouter.get("/google/oauth/start", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(startGoogleOAuth));
integrationRouter.get("/razorpay_oauth/oauth/start", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(startRazorpayOAuth));
integrationRouter.get("/razorpay_oauth/callback", asyncHandler(razorpayOAuthCallback));
integrationRouter.get("/razorpay_oauth/payments", requireRole("owner", "admin"), asyncHandler(razorpayOAuthPreview));
integrationRouter.delete("/razorpay_oauth", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(removeRazorpayOAuth));
integrationRouter.get("/:provider(zoho|salesforce)/oauth/start", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(startCrmOAuth));
integrationRouter.get("/:provider(zoho|salesforce)/callback", asyncHandler(crmOAuthCallback));
integrationRouter.get("/:provider(zoho|salesforce)/preview", requireRole("owner", "admin"), asyncHandler(crmOAuthPreview));
integrationRouter.delete("/:provider(zoho|salesforce)", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(removeCrmOAuth));
integrationRouter.get("/google/callback", asyncHandler(googleOAuthCallback));
integrationRouter.delete("/google", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(removeGoogleConnection));
integrationRouter.get("/google/calendars", asyncHandler(googleCalendars));
integrationRouter.get("/google/drive/preview", requireRole("owner", "admin"), asyncHandler(googleDrivePreview));
integrationRouter.get("/google/docs/preview", requireRole("owner", "admin"), asyncHandler(googleDocsPreview));
integrationRouter.get("/google/gmail/preview", requireRole("owner", "admin"), asyncHandler(gmailPreview));
integrationRouter.post("/google/spreadsheet", requireWhiteLabelWriteAccess, asyncHandler(googleSpreadsheet));
integrationRouter.post("/google/spreadsheet/create", requireWhiteLabelWriteAccess, asyncHandler(createSpreadsheet));
integrationRouter.post("/google/calendar/test", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(testGoogleCalendar));
integrationRouter.post("/google/sheets/test", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(testGoogleSheet));
integrationRouter.get("/razorpay_api/payments", requireRole("owner", "admin"), asyncHandler(razorpayPayments));
integrationRouter.get("/:provider/preview", requireRole("owner", "admin"), asyncHandler(tokenProviderPreview));

// WhatsApp Integration Routes
integrationRouter.post("/whatsapp/embedded-signup", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(handleEmbeddedSignup));
integrationRouter.get("/whatsapp/status", asyncHandler(getWhatsAppStatus));
integrationRouter.post("/whatsapp/test-message", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(sendWhatsAppTestMessage));
integrationRouter.delete("/whatsapp", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectWhatsApp));

integrationRouter.put("/:provider", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(connectIntegration));
integrationRouter.delete("/:provider", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(disconnectIntegration));
