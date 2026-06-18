import { Router } from "express";

import {
  billingSummary,
  createCreditTopUp,
  createPortal,
  listBillingTransactions,
  saveAutoReload,
} from "../controllers/billingController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const billingRouter = Router();

billingRouter.use(requireAuth);
billingRouter.get("/summary", asyncHandler(billingSummary));
billingRouter.get("/transactions", asyncHandler(listBillingTransactions));
billingRouter.post("/top-up", requireRole("owner", "billing"), asyncHandler(createCreditTopUp));
billingRouter.put("/auto-reload", requireRole("owner", "billing"), asyncHandler(saveAutoReload));
billingRouter.post("/portal", requireRole("owner", "billing"), asyncHandler(createPortal));
