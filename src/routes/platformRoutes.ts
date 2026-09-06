import { Router } from "express";

import {
  createWhiteLabelAccount,
  getWhiteLabelAccount,
  listEligibleWhiteLabelOrganizations,
  listPlatformAuditLogs,
  listWhiteLabelAccounts,
  updateWhiteLabelAccountCommercials,
  updateWhiteLabelAccountStatus,
} from "../controllers/platformWhiteLabelController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requirePlatformRole } from "../middleware/auth.js";
import { requireWhiteLabelEnabled } from "../middleware/whiteLabelEnabled.js";

export const platformRouter = Router();

platformRouter.use(requireAuth, requirePlatformRole("super_admin"), requireWhiteLabelEnabled);
platformRouter.get("/white-label/accounts", asyncHandler(listWhiteLabelAccounts));
platformRouter.get("/white-label/eligible-organizations", asyncHandler(listEligibleWhiteLabelOrganizations));
platformRouter.post("/white-label/accounts", asyncHandler(createWhiteLabelAccount));
platformRouter.get("/white-label/accounts/:accountId", asyncHandler(getWhiteLabelAccount));
platformRouter.patch("/white-label/accounts/:accountId/status", asyncHandler(updateWhiteLabelAccountStatus));
platformRouter.patch("/white-label/accounts/:accountId/commercials", asyncHandler(updateWhiteLabelAccountCommercials));
platformRouter.get("/audit-log", asyncHandler(listPlatformAuditLogs));
