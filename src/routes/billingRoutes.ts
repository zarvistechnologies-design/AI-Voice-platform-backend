import { Router } from "express";

import { billingSummary, createCheckout, createPortal } from "../controllers/billingController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const billingRouter = Router();

billingRouter.use(requireAuth);
billingRouter.get("/summary", asyncHandler(billingSummary));
billingRouter.post("/checkout", requireRole("owner", "billing"), asyncHandler(createCheckout));
billingRouter.post("/portal", requireRole("owner", "billing"), asyncHandler(createPortal));
