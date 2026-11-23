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
import { OrganizationModel } from "../models/Organization.js";
import { UserModel } from "../models/User.js";
import { whiteLabelCustomerBillingSummary } from "../services/whiteLabelCustomerBillingService.js";
import { normalizeOptionalGstin } from "../utils/gstin.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

export async function billingSummary(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const inrPerUsd = Number.isFinite(env.costRates.inrPerUsd) && env.costRates.inrPerUsd > 0
    ? env.costRates.inrPerUsd
    : 96.5;
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
  const [subscription, wallet, usage, invoices, transactions, organization] = await Promise.all([
    ensureBillingSubscription(id),
    ensureCreditWallet(id),
    billingUsage(id),
    BillingInvoiceModel.find({ orgId: id }).sort({ createdAt: -1 }).limit(12),
    recentCreditTransactions(id, 25),
    OrganizationModel.findById(id).select("name billingProfile").lean(),
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
      currency: "INR",
    },
    enterpriseMonthlyUsd: env.razorpayEnterpriseMonthlyUsd,
    enterpriseMonthlyInr: Math.round(env.razorpayEnterpriseMonthlyUsd * inrPerUsd * 100) / 100,
    displayCurrency: "INR",
    inrPerUsd,
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
    billingProfile: {
      companyName: organization?.name ?? "",
      gstin: organization?.billingProfile?.gstin ?? "",
      address: organization?.billingProfile?.address ?? "",
      phone: organization?.billingProfile?.phone ?? "",
      country: organization?.billingProfile?.country ?? "",
      state: organization?.billingProfile?.state ?? "",
      postalCode: organization?.billingProfile?.postalCode ?? "",
    },
    canManageBillingProfile: ["owner", "admin", "billing"].includes(request.organization?.role ?? ""),
  });
}

export async function saveBillingProfile(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const fields: Record<string, string> = {};
  if (request.body.gstin !== undefined) fields["billingProfile.gstin"] = normalizeOptionalGstin(request.body.gstin);
  for (const [key, limit] of Object.entries({ address: 500, phone: 30, country: 80, state: 100, postalCode: 20 })) {
    if (request.body[key] === undefined) continue;
    if (typeof request.body[key] !== "string") throw new HttpError(400, `Invalid ${key}.`);
    const value = request.body[key].trim();
    if (value.length > limit) throw new HttpError(400, `${key} must be ${limit} characters or fewer.`);
    fields[`billingProfile.${key}`] = value;
  }
  if (request.body.phone !== undefined && fields["billingProfile.phone"] && !/^\+?[0-9() .-]{7,30}$/.test(fields["billingProfile.phone"])) throw new HttpError(400, "Enter a valid business phone number.");
  if (request.body.companyName !== undefined) {
    if (typeof request.body.companyName !== "string" || request.body.companyName.trim().length < 2 || request.body.companyName.trim().length > 100) throw new HttpError(400, "Enter a company name between 2 and 100 characters.");
    fields.name = request.body.companyName.trim();
  }
  if (request.body.completeOnboarding === true) {
    if (request.body.termsAccepted !== true) throw new HttpError(400, "Agree to the Terms of Service and Privacy Policy to continue.");
    for (const key of ["name", "billingProfile.phone", "billingProfile.country", "billingProfile.state", "billingProfile.postalCode", "billingProfile.address"]) {
      if (!fields[key]) throw new HttpError(400, "Complete the business and billing details.");
    }
  }
  if (!Object.keys(fields).length) throw new HttpError(400, "No billing details provided.");
  const organization = await OrganizationModel.findByIdAndUpdate(
    id,
    { $set: { ...fields, ...(request.body.completeOnboarding === true ? { businessDetailsRequired: false } : {}) } },
    { new: true, runValidators: true },
  ).select("name billingProfile");
  if (!organization) throw new HttpError(404, "Organization not found.");
  if (request.body.completeOnboarding === true && request.user) {
    await UserModel.updateOne({ _id: request.user.id }, { $set: { termsAcceptedAt: new Date() } });
  }
  response.json({
    billingProfile: {
      companyName: organization.name,
      gstin: organization.billingProfile?.gstin ?? "",
      address: organization.billingProfile?.address ?? "",
      phone: organization.billingProfile?.phone ?? "",
      country: organization.billingProfile?.country ?? "",
      state: organization.billingProfile?.state ?? "",
      postalCode: organization.billingProfile?.postalCode ?? "",
    },
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
