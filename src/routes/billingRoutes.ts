import { Router } from "express";

import type { NextFunction, Response } from "express";

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
import {
  createWhiteLabelCustomerCheckout,
  downloadWhiteLabelCustomerInvoice,
  getWhiteLabelCustomerBilling,
  verifyWhiteLabelCustomerCheckout,
} from "../controllers/whiteLabelCustomerBillingController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireWhiteLabelEnabled } from "../middleware/whiteLabelEnabled.js";
import { HttpError } from "../utils/httpError.js";

export const billingRouter = Router();

function requirePlatformDirectBilling(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  if (request.organization?.whiteLabelAccountId) {
    next(new HttpError(403, "Payments for this organization are managed by its white-label provider."));
    return;
  }
  next();
}

billingRouter.use(requireAuth);
billingRouter.get("/summary", asyncHandler(billingSummary));
billingRouter.get("/transactions", asyncHandler(listBillingTransactions));
billingRouter.get("/white-label", requireWhiteLabelEnabled, asyncHandler(getWhiteLabelCustomerBilling));
billingRouter.post("/white-label/checkout", requireWhiteLabelEnabled, requireRole("owner", "billing"), asyncHandler(createWhiteLabelCustomerCheckout));
billingRouter.post("/white-label/verify", requireWhiteLabelEnabled, requireRole("owner", "billing"), asyncHandler(verifyWhiteLabelCustomerCheckout));
billingRouter.get("/white-label/invoices/:invoiceId", requireWhiteLabelEnabled, asyncHandler(downloadWhiteLabelCustomerInvoice));
billingRouter.post("/top-up", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(createRazorpayTopUp));
billingRouter.post("/razorpay/verify", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(verifyRazorpayPayment));
billingRouter.post("/checkout", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(createEnterpriseSubscription));
billingRouter.post("/razorpay/subscription/verify", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(verifyEnterpriseSubscription));
billingRouter.post("/razorpay/subscription/cancel", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(cancelEnterpriseSubscription));
billingRouter.get("/invoices", requirePlatformDirectBilling, asyncHandler(listRazorpayInvoices));
billingRouter.get("/invoices/:invoiceId", requirePlatformDirectBilling, asyncHandler(downloadBillingInvoice));
billingRouter.put("/auto-reload", requireRole("owner", "billing"), requirePlatformDirectBilling, asyncHandler(saveAutoReload));

