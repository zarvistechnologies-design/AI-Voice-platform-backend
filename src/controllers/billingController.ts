import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import {
  billingUsage,
  creditBillingSettings,
  ensureBillingSubscription,
  ensureCreditWallet,
  planCatalog,
  recentCreditTransactions,
  updateAutoReloadSettings,
} from "../services/billingService.js";
import { HttpError } from "../utils/httpError.js";
import { razorpayConfigured } from "../services/razorpayService.js";
import { env } from "../config/env.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

export async function billingSummary(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const [subscription, wallet, usage, invoices, transactions] = await Promise.all([
    ensureBillingSubscription(id),
    ensureCreditWallet(id),
    billingUsage(id),
    BillingInvoiceModel.find({ orgId: id }).sort({ createdAt: -1 }).limit(12),
    recentCreditTransactions(id, 25),
  ]);
  response.json({
    configured: razorpayConfigured(),
    paymentReadiness: {
      credentialsConfigured: razorpayConfigured(),
      webhookConfigured: Boolean(env.razorpayWebhookSecret),
      mode: env.razorpayKeyId.startsWith("rzp_live_")
        ? "live"
        : env.razorpayKeyId.startsWith("rzp_test_")
          ? "test"
          : "unconfigured",
      currency: "USD",
    },
    enterpriseMonthlyUsd: env.razorpayEnterpriseMonthlyUsd,
    paymentProvider: razorpayConfigured() ? "razorpay" : "internal",
    billingModel: "pay_as_you_go",
    subscription,
    wallet,
    creditSettings: creditBillingSettings,
    currentPlan: planCatalog.free,
    plans: [planCatalog.free],
    usage,
    invoices,
    transactions,
  });
}

export async function saveAutoReload(request: AuthenticatedRequest, response: Response) {
  const wallet = await updateAutoReloadSettings(orgId(request), {
    enabled: request.body.enabled === true,
    thresholdCredits: Number(request.body.thresholdCredits),
    reloadAmountCredits: Number(request.body.reloadAmountCredits),
  });
  response.json({ wallet });
}

export async function listBillingTransactions(request: AuthenticatedRequest, response: Response) {
  response.json({ transactions: await recentCreditTransactions(orgId(request), Number(request.query.limit) || 50) });
}
