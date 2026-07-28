import { Router } from "express";

import {
  connectIntegration,
  disconnectIntegration,
  listIntegrations,
  startGoogleOAuth,
  googleOAuthCallback,
  removeGoogleConnection,
  googleCalendars,
  googleSpreadsheet,
  testGoogleCalendar,
  testGoogleSheet,
} from "../controllers/integrationController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const integrationRouter = Router();

integrationRouter.use(requireAuth);
integrationRouter.get("/", asyncHandler(listIntegrations));
integrationRouter.get("/google/oauth/start", requireRole("owner", "admin"), asyncHandler(startGoogleOAuth));
integrationRouter.get("/google/callback", asyncHandler(googleOAuthCallback));
integrationRouter.delete("/google", requireRole("owner", "admin"), asyncHandler(removeGoogleConnection));
integrationRouter.get("/google/calendars", asyncHandler(googleCalendars));
integrationRouter.post("/google/spreadsheet", asyncHandler(googleSpreadsheet));
integrationRouter.post("/google/calendar/test", requireRole("owner", "admin"), asyncHandler(testGoogleCalendar));
integrationRouter.post("/google/sheets/test", requireRole("owner", "admin"), asyncHandler(testGoogleSheet));
integrationRouter.put("/:provider", requireRole("owner", "admin"), asyncHandler(connectIntegration));
integrationRouter.delete("/:provider", requireRole("owner", "admin"), asyncHandler(disconnectIntegration));
