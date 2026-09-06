import { Router } from "express";

import { submitCustomerCase } from "../controllers/customerCaseController.js";
import { streamSignedCallRecordingFile } from "../controllers/callController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { publicBrandConfiguration } from "../controllers/publicBrandController.js";

export const publicRouter = Router();

const conciergeLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: "Too many requests from this connection. Please contact support.",
});

publicRouter.post("/customer-cases", conciergeLimit, asyncHandler(submitCustomerCase));
publicRouter.get("/brand", asyncHandler(publicBrandConfiguration));
publicRouter.get("/recordings/:callId", asyncHandler(streamSignedCallRecordingFile));
