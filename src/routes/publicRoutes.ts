import { Router } from "express";

import { submitCustomerCase } from "../controllers/customerCaseController.js";
import { streamSignedCallRecordingFile } from "../controllers/callController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { publicBrandConfiguration } from "../controllers/publicBrandController.js";

import {
  createDemoWebToken,
  getDemoScenariosConfig,
  initiateDemoCall,
} from "../controllers/demoCallController.js";

export const publicRouter = Router();

const conciergeLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: "Too many requests from this connection. Please contact support.",
});

const demoCallLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many demo call attempts. Please wait a moment before trying again.",
});

publicRouter.post("/customer-cases", conciergeLimit, asyncHandler(submitCustomerCase));
publicRouter.get("/brand", asyncHandler(publicBrandConfiguration));
publicRouter.get("/recordings/:callId", asyncHandler(streamSignedCallRecordingFile));

// Interactive Demo Agent endpoints (Outbound phone call & in-browser WebRTC voice)
publicRouter.get("/demo/scenarios", asyncHandler(getDemoScenariosConfig));
publicRouter.post("/demo/call", demoCallLimit, asyncHandler(initiateDemoCall));
publicRouter.post("/demo/token", demoCallLimit, asyncHandler(createDemoWebToken));
