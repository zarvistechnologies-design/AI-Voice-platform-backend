import { Router } from "express";

import {
  billingSummary,
  listBillingTransactions,
  saveAutoReload,
} from "../controllers/billingController.js";
import {
  cancelEnterpriseSubscription,
  createEnterpriseSubscription,
  createRazorpayTopUp,
  downloadBillingInvoice,
  listRazorpayInvoices,
  verifyEnterpriseSubscription,
  verifyRazorpayPayment,
} from "../controllers/razorpayBillingController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const billingRouter = Router();

billingRouter.use(requireAuth);
billingRouter.get("/summary", asyncHandler(billingSummary));
billingRouter.get("/transactions", asyncHandler(listBillingTransactions));
billingRouter.post("/top-up", requireRole("owner", "billing"), asyncHandler(createRazorpayTopUp));
billingRouter.post("/razorpay/verify", requireRole("owner", "billing"), asyncHandler(verifyRazorpayPayment));
billingRouter.post("/checkout", requireRole("owner", "billing"), asyncHandler(createEnterpriseSubscription));
billingRouter.post("/razorpay/subscription/verify", requireRole("owner", "billing"), asyncHandler(verifyEnterpriseSubscription));
billingRouter.post("/razorpay/subscription/cancel", requireRole("owner", "billing"), asyncHandler(cancelEnterpriseSubscription));
billingRouter.get("/invoices", asyncHandler(listRazorpayInvoices));
billingRouter.get("/invoices/:invoiceId", asyncHandler(downloadBillingInvoice));
billingRouter.put("/auto-reload", requireRole("owner", "billing"), asyncHandler(saveAutoReload));

