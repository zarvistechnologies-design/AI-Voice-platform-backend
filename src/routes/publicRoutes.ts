import { Router } from "express";

import { submitCustomerCase } from "../controllers/customerCaseController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createRateLimit } from "../middleware/rateLimit.js";

export const publicRouter = Router();

const conciergeLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: "Too many requests from this connection. Please email hello@vozon.ai.",
});

publicRouter.post("/customer-cases", conciergeLimit, asyncHandler(submitCustomerCase));
