import { Router } from "express";

import {
  connectIntegration,
  disconnectIntegration,
  listIntegrations,
} from "../controllers/integrationController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const integrationRouter = Router();

integrationRouter.use(requireAuth);
integrationRouter.get("/", asyncHandler(listIntegrations));
integrationRouter.put("/:provider", requireRole("owner", "admin"), asyncHandler(connectIntegration));
integrationRouter.delete("/:provider", requireRole("owner", "admin"), asyncHandler(disconnectIntegration));
