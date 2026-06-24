import { Router } from "express";

import {
  createPublicWidgetToken,
  getPublicWidgetAgent,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const widgetRouter = Router();

widgetRouter.get("/agents/:agentId", asyncHandler(getPublicWidgetAgent));
widgetRouter.post("/call-token", asyncHandler(createPublicWidgetToken));
