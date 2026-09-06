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
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { whiteLabelCustomerBillingSummary } from "../services/whiteLabelCustomerBillingService.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

export async function billingSummary(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  if (request.organization?.whiteLabelAccountId) {
    const [subscription, brand, account, wallet, usage, platformInvoices, transactions] = await Promise.all([
      WhiteLabelSubscriptionModel.findOne({
        orgId: id,
        accountId: request.organization.whiteLabelAccountId,
      }).lean(),
      WhiteLabelBrandModel.findById(request.organization.whiteLabelBrandId)
        .select("branding.productName support.email")
        .lean(),
      WhiteLabelAccountModel.findById(request.organization.whiteLabelAccountId)
        .select("retailBilling")
        .lean(),
      ensureCreditWallet(id),
      billingUsage(id),
      BillingInvoiceModel.find({ orgId: id }).sort({ createdAt: -1 }).limit(12),
      recentCreditTransactions(id, 25),
    ]);
    if (!subscription) throw new HttpError(402, "No customer subscription is assigned to this organization.");
    const retailBilling = account?.retailBilling?.enabled
      ? await whiteLabelCustomerBillingSummary(id)
      : null;
    const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
    const limits = (subscription.limitsSnapshot ?? {}) as Record<string, unknown>;
    const usagePricing = (subscription.usagePricingSnapshot ?? {}) as Record<string, unknown>;
    const currentPlan = {
      id: subscription.planKey,
      name: subscription.planKey,
      monthlyPrice: price.interval === "month" ? Number(price.recurringAmountMinor ?? 0) / 100 : null,
      currency: price.currency ?? "USD",
      interval: price.interval ?? "month",
      limits,
    };
    response.json({
      configured: Boolean(retailBilling && razorpayConfigured() && env.razorpayWebhookSecret),
      paymentReadiness: {
        credentialsConfigured: retailBilling ? razorpayConfigured() : false,
        webhookConfigured: retailBilling ? Boolean(env.razorpayWebhookSecret) : false,
        mode: retailBilling
          ? env.razorpayKeyId.startsWith("rzp_live_") ? "live" : env.razorpayKeyId.startsWith("rzp_test_") ? "test" : "unconfigured"
          : "partner_managed",
        currency: price.currency ?? "USD",
      },
      paymentProvider: subscription.provider,
      billingModel: retailBilling ? "white_label_customer_checkout" : "white_label_partner_managed",
      subscription,
      wallet,
      creditSettings: { ...creditBillingSettings, partnerUsagePricing: usagePricing },
      currentPlan,
      plans: [currentPlan],
      usage,
      invoices: retailBilling?.invoices ?? platformInvoices,
      currentInvoice: retailBilling?.invoice ?? null,
      transactions,
      whiteLabel: {
        productName: brand?.branding?.productName ?? "Branded voice platform",
        supportEmail: brand?.support?.email ?? "",
        managedByPartner: !retailBilling,
      },
    });
    return;
  }
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
