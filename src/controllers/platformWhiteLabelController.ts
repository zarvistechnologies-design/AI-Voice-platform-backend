import { startSession, Types } from "mongoose";
import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { OrganizationModel } from "../models/Organization.js";
import { PlatformAuditLogModel } from "../models/PlatformAuditLog.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelDomainModel } from "../models/WhiteLabelDomain.js";
import { WhiteLabelPlanModel } from "../models/WhiteLabelPlan.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import {
  normalizeSlug,
  recordPlatformAudit,
  validateBrandColor,
  validateBrandAssetUrl,
  validateEmail,
  validateHttpsUrl,
} from "../services/whiteLabelService.js";
import { HttpError } from "../utils/httpError.js";
import {
  fullWhiteLabelModelAccess,
  parseWhiteLabelModelAccess,
  whiteLabelModelCatalog,
} from "../services/whiteLabelModelAccessService.js";

function text(value: unknown, field: string, minimum: number, maximum: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new HttpError(400, `${field} must be between ${minimum} and ${maximum} characters.`);
  }
  return normalized;
}

function integer(value: unknown, field: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${field} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function decimal(value: unknown, field: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${field} must be between ${minimum} and ${maximum}.`);
  }
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function boolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function contractInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  const currency = String(input.currency ?? "USD").trim().toUpperCase();
  if (currency !== "USD" && currency !== "INR") {
    throw new HttpError(400, "Contract currency must be USD or INR until an audited FX feed is configured.");
  }
  const billingInterval = input.billingInterval === "year" ? "year" : "month";
  return {
    currency,
    billingInterval,
    platformFeeMinor: integer(input.platformFeeMinor ?? 0, "Platform fee", 0, 1_000_000_000_000),
    minimumCommitmentMinor: integer(input.minimumCommitmentMinor ?? 0, "Minimum commitment", 0, 1_000_000_000_000),
    includedCredits: decimal(input.includedCredits ?? 0, "Included credits", 0, 1_000_000_000),
    wholesaleMarkupBps: integer(input.wholesaleMarkupBps ?? 0, "Wholesale markup", 0, 100_000),
    platformFeePerMinuteCredits: decimal(input.platformFeePerMinuteCredits ?? 0, "Per-minute platform fee", 0, 1_000_000),
    paymentTermsDays: integer(input.paymentTermsDays ?? 0, "Payment terms", 0, 180),
    creditLimitCredits: decimal(input.creditLimitCredits ?? 0, "Credit limit", 0, 1_000_000_000),
    autoSuspendOnPastDue: boolean(input.autoSuspendOnPastDue, true),
    effectiveAt: input.effectiveAt ? new Date(String(input.effectiveAt)) : new Date(),
  };
}

function limitsInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    brands: integer(input.brands ?? 1, "Brand limit", 1, 100),
    customerOrganizations: integer(input.customerOrganizations ?? 25, "Customer organization limit", 1, 1_000_000),
    agentsPerCustomer: integer(input.agentsPerCustomer ?? 10, "Agent limit", 1, 100_000),
    membersPerCustomer: integer(input.membersPerCustomer ?? 25, "Member limit", 1, 100_000),
    phoneNumbersPerCustomer: integer(input.phoneNumbersPerCustomer ?? 10, "Phone-number limit", 0, 100_000),
    concurrentCallsPerCustomer: integer(input.concurrentCallsPerCustomer ?? 10, "Concurrent-call limit", 1, 100_000),
    monthlyMinutesPerCustomer: integer(input.monthlyMinutesPerCustomer ?? 10_000, "Monthly-minute limit", 0, 1_000_000_000),
  };
}

function entitlementsInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    customDomains: boolean(input.customDomains, true),
    customApiDomains: boolean(input.customApiDomains, false),
    customEmailBranding: boolean(input.customEmailBranding, true),
    removePoweredBy: boolean(input.removePoweredBy, false),
    customCustomerPricing: boolean(input.customCustomerPricing, true),
    multipleBrands: boolean(input.multipleBrands, false),
    bringYourOwnProviders: boolean(input.bringYourOwnProviders, false),
    advancedAnalytics: boolean(input.advancedAnalytics, true),
    developerApi: boolean(input.developerApi, true),
  };
}

function retailBillingInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  const linkedAccountId = String(input.razorpayLinkedAccountId ?? "").trim();
  const transferMode = input.transferMode === "full_amount" ? "full_amount" as const : "disabled" as const;
  if (linkedAccountId && !/^acc_[A-Za-z0-9]+$/.test(linkedAccountId)) {
    throw new HttpError(400, "Razorpay linked account ID must start with acc_.");
  }
  if (transferMode === "full_amount" && !linkedAccountId) {
    throw new HttpError(400, "Full-amount settlement requires a Razorpay linked account ID.");
  }
  return {
    enabled: input.enabled === true,
    provider: "razorpay" as const,
    razorpayLinkedAccountId: linkedAccountId,
    transferMode,
    taxRateBps: integer(input.taxRateBps ?? 0, "Retail tax rate", 0, 100_000),
    taxLabel: String(input.taxLabel ?? "Tax").trim().slice(0, 80) || "Tax",
    taxRegistrationId: String(input.taxRegistrationId ?? "").trim().slice(0, 160),
    gracePeriodDays: integer(input.gracePeriodDays ?? 3, "Customer payment grace period", 0, 90),
  };
}

function defaultBrandInput(value: unknown, accountName: string) {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    key: normalizeSlug(input.key, "default"),
    status: "draft" as const,
    isDefault: true,
    branding: {
      productName: text(input.productName ?? accountName, "Product name", 2, 80),
      companyName: text(input.companyName ?? accountName, "Company name", 2, 120),
      logoUrl: validateBrandAssetUrl(input.logoUrl, "Logo URL"),
      logoDarkUrl: validateBrandAssetUrl(input.logoDarkUrl, "Dark logo URL"),
      iconUrl: validateBrandAssetUrl(input.iconUrl, "Icon URL"),
      primaryColor: validateBrandColor(input.primaryColor ?? "#45ddce", "Primary color"),
      secondaryColor: validateBrandColor(input.secondaryColor ?? "#071b18", "Secondary color"),
      accentColor: validateBrandColor(input.accentColor ?? "#75fff0", "Accent color"),
      surfaceColor: validateBrandColor(input.surfaceColor ?? "#020807", "Surface color"),
      defaultTheme: input.defaultTheme === "light" || input.defaultTheme === "system" ? input.defaultTheme : "dark",
      poweredByText: "Powered by Vozon",
    },
    support: {
      email: validateEmail(input.supportEmail, "Support email"),
      phone: String(input.supportPhone ?? "").trim().slice(0, 40),
      websiteUrl: validateHttpsUrl(input.websiteUrl, "Website URL"),
      helpCenterUrl: validateHttpsUrl(input.helpCenterUrl, "Help-center URL"),
      statusPageUrl: validateHttpsUrl(input.statusPageUrl, "Status-page URL"),
    },
    legal: {
      termsUrl: validateHttpsUrl(input.termsUrl, "Terms URL"),
      privacyUrl: validateHttpsUrl(input.privacyUrl, "Privacy URL"),
      cookiePolicyUrl: validateHttpsUrl(input.cookiePolicyUrl, "Cookie-policy URL"),
      legalBusinessName: String(input.legalBusinessName ?? accountName).trim().slice(0, 160),
      businessAddress: String(input.businessAddress ?? "").trim().slice(0, 500),
    },
    email: {
      fromName: String(input.emailFromName ?? input.productName ?? accountName).trim().slice(0, 120),
      fromAddress: validateEmail(input.emailFromAddress, "Email from address"),
      replyTo: validateEmail(input.replyTo, "Reply-to address"),
    },
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listEligibleWhiteLabelOrganizations(request: AuthenticatedRequest, response: Response) {
  const search = String(request.query.search ?? "").trim();
  const filter: Record<string, unknown> = {
    // Organizations created before lifecycle tracking have no stored value;
    // the rest of the application already treats those legacy records as active.
    lifecycleStatus: { $nin: ["suspended", "archived"] },
    whiteLabelAccountId: { $exists: false },
  };
  if (search) {
    const regex = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: regex }, { slug: regex }];
  }
  const ownerOrgIds = await WhiteLabelAccountModel.distinct("ownerOrgId");
  if (ownerOrgIds.length) filter._id = { $nin: ownerOrgIds };
  const organizations = await OrganizationModel.find(filter)
    .select("name slug ownerUserId lifecycleStatus createdAt")
    .populate("ownerUserId", "name email emailVerified twoFactorEnabled")
    .sort({ createdAt: -1 })
    .limit(50);
  response.json({ organizations });
}

export async function listWhiteLabelAccounts(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 25));
  const filter: Record<string, unknown> = {};
  const status = String(request.query.status ?? "").trim();
  const search = String(request.query.search ?? "").trim();
  if (status) filter.status = status;
  if (search) {
    const regex = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: regex }, { slug: regex }];
  }
  const [accounts, total] = await Promise.all([
    WhiteLabelAccountModel.find(filter)
      .populate("ownerOrgId", "name slug lifecycleStatus")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    WhiteLabelAccountModel.countDocuments(filter),
  ]);
  response.json({ accounts, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } });
}

export async function createWhiteLabelAccount(request: AuthenticatedRequest, response: Response) {
  const ownerOrgId = String(request.body.ownerOrgId ?? "");
  if (!Types.ObjectId.isValid(ownerOrgId)) throw new HttpError(400, "A valid owner organization is required.");
  const organization = await OrganizationModel.findOne({
    _id: ownerOrgId,
    lifecycleStatus: { $nin: ["suspended", "archived"] },
  });
  if (!organization) throw new HttpError(404, "Owner organization not found or not active.");
  if (organization.whiteLabelAccountId) {
    throw new HttpError(409, "A customer organization cannot also own a white-label account.");
  }
  if (await WhiteLabelAccountModel.exists({ ownerOrgId })) {
    throw new HttpError(409, "This organization already owns a white-label account.");
  }
  const name = text(request.body.name ?? organization.name, "Account name", 2, 120);
  const slug = normalizeSlug(request.body.slug, name);
  const accountInput = {
    ownerOrgId: organization._id,
    name,
    slug,
    status: "onboarding" as const,
    contract: contractInput(request.body.contract),
    limits: limitsInput(request.body.limits),
    entitlements: entitlementsInput(request.body.entitlements),
    modelAccess: parseWhiteLabelModelAccess(request.body.modelAccess, {
      fallback: fullWhiteLabelModelAccess(),
    }),
    retailBilling: retailBillingInput(request.body.retailBilling),
    billingStatus: request.body.billingStatus === "trialing" ? "trialing" as const : "not_configured" as const,
    onboarding: { approvedAt: new Date() },
    usage: { brands: 1, customerOrganizations: 0 },
  };
  const brandInput = defaultBrandInput(request.body.defaultBrand, name);
  const session = await startSession();
  const accountId = new Types.ObjectId();
  const brandId = new Types.ObjectId();
  try {
    await session.withTransaction(async () => {
      await WhiteLabelAccountModel.create([{ _id: accountId, ...accountInput }], { session });
      await WhiteLabelBrandModel.create([{ _id: brandId, ...brandInput, accountId }], { session });
      await OrganizationModel.updateOne(
        { _id: organization._id, whiteLabelOwnerAccountId: { $exists: false } },
        { $set: { whiteLabelOwnerAccountId: accountId } },
        { session },
      );
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new HttpError(409, "White-label account slug is already in use.");
    throw error;
  } finally {
    await session.endSession();
  }
  const [account, brand] = await Promise.all([
    WhiteLabelAccountModel.findById(accountId),
    WhiteLabelBrandModel.findById(brandId),
  ]);
  if (!account || !brand) throw new Error("White-label account transaction completed without a result.");
  await recordPlatformAudit(request, {
    action: "white_label.account_created",
    resource: "white_label_account",
    resourceId: account.id,
    accountId: account.id,
    targetOrgId: ownerOrgId,
    reason: String(request.body.reason ?? "Initial white-label approval").trim(),
    after: { account: account.toObject(), defaultBrandId: brand.id },
  });
  response.status(201).json({ account, defaultBrand: brand });
}

export async function getWhiteLabelAccount(request: AuthenticatedRequest, response: Response) {
  const account = await WhiteLabelAccountModel.findById(request.params.accountId)
    .populate("ownerOrgId", "name slug lifecycleStatus ownerUserId");
  if (!account) throw new HttpError(404, "White-label account not found.");
  const [brands, domains, plans, customerCount, subscriptions] = await Promise.all([
    WhiteLabelBrandModel.find({ accountId: account._id }).sort({ isDefault: -1, createdAt: 1 }),
    WhiteLabelDomainModel.find({ accountId: account._id }).sort({ createdAt: -1 }),
    WhiteLabelPlanModel.find({ accountId: account._id }).sort({ key: 1, version: -1 }),
    OrganizationModel.countDocuments({ whiteLabelAccountId: account._id }),
    WhiteLabelSubscriptionModel.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);
  response.json({
    account,
    brands,
    domains,
    plans,
    customerCount,
    subscriptions,
    modelAccessCatalog: whiteLabelModelCatalog(),
  });
}

const statusTransitions: Record<string, string[]> = {
  draft: ["onboarding", "terminated"],
  onboarding: ["active", "suspended", "terminated"],
  active: ["suspended", "terminated"],
  suspended: ["active", "terminated"],
  terminated: [],
};

export async function updateWhiteLabelAccountStatus(request: AuthenticatedRequest, response: Response) {
  const requestedStatus = String(request.body.status ?? "");
  const billingStatus = String(request.body.billingStatus ?? "");
  const reason = String(request.body.reason ?? "").trim();
  if (reason.length < 8 || reason.length > 2_000) {
    throw new HttpError(400, "A reason of at least 8 characters is required for lifecycle changes.");
  }
  const account = await WhiteLabelAccountModel.findById(request.params.accountId);
  if (!account) throw new HttpError(404, "White-label account not found.");
  const status = requestedStatus || account.status;
  if (status === account.status && !billingStatus) {
    throw new HttpError(400, "Provide a new lifecycle or billing status.");
  }
  if (status !== account.status && !statusTransitions[account.status]?.includes(status)) {
    throw new HttpError(409, `Cannot move a white-label account from ${account.status} to ${status}.`);
  }
  if (billingStatus && !["not_configured", "trialing", "active", "past_due", "suspended", "cancelled"].includes(billingStatus)) {
    throw new HttpError(400, "Invalid billing status.");
  }
  const nextBillingStatus = billingStatus || account.billingStatus;
  if (status === "active") {
    if (nextBillingStatus !== "trialing" && nextBillingStatus !== "active") {
      throw new HttpError(409, "Billing must be trialing or active before the account can be activated.");
    }
    const publishedDefault = await WhiteLabelBrandModel.exists({ accountId: account._id, isDefault: true, status: "published" });
    if (!publishedDefault) throw new HttpError(409, "Publish the default brand before activating this account.");
  }
  const before = account.toObject();
  account.status = status as typeof account.status;
  if (billingStatus) account.billingStatus = billingStatus as typeof account.billingStatus;
  if (status === "active") account.set("onboarding.activatedAt", new Date());
  if (status === "suspended") {
    account.set("onboarding.suspendedAt", new Date());
    account.set("onboarding.suspensionReason", reason);
  }
  if (status === "terminated") account.set("onboarding.terminatedAt", new Date());
  await account.save();
  await recordPlatformAudit(request, {
    action: `white_label.account_${status}`,
    resource: "white_label_account",
    resourceId: account.id,
    accountId: account.id,
    targetOrgId: String(account.ownerOrgId),
    reason,
    before,
    after: account.toObject(),
  });
  response.json({ account });
}

export async function updateWhiteLabelAccountCommercials(request: AuthenticatedRequest, response: Response) {
  const reason = String(request.body.reason ?? "").trim();
  if (reason.length < 8 || reason.length > 2_000) {
    throw new HttpError(400, "A reason of at least 8 characters is required for commercial changes.");
  }
  const account = await WhiteLabelAccountModel.findById(request.params.accountId);
  if (!account) throw new HttpError(404, "White-label account not found.");
  if (account.status === "terminated") throw new HttpError(409, "Terminated accounts cannot be changed.");
  const before = account.toObject();
  if (request.body.contract) account.set("contract", contractInput(request.body.contract));
  if (request.body.limits) account.set("limits", limitsInput(request.body.limits));
  if (request.body.entitlements) account.set("entitlements", entitlementsInput(request.body.entitlements));
  if (request.body.retailBilling) {
    const retailBilling = retailBillingInput(request.body.retailBilling);
    if (retailBilling.enabled && retailBilling.transferMode === "full_amount") {
      const [usdPlan, usdSubscription] = await Promise.all([
        WhiteLabelPlanModel.exists({ accountId: account._id, status: "published", "price.currency": { $ne: "INR" } }),
        WhiteLabelSubscriptionModel.exists({
          accountId: account._id,
          status: { $nin: ["cancelled", "expired"] },
          "priceSnapshot.currency": { $ne: "INR" },
        }),
      ]);
      if (usdPlan || usdSubscription) {
        throw new HttpError(409, "Full-amount Razorpay Route settlement cannot be enabled while a published or assigned customer plan uses a non-INR currency.");
      }
    }
    if (retailBilling.enabled && retailBilling.taxRateBps > 0) {
      const [unspecifiedPlan, unspecifiedSubscription] = await Promise.all([
        WhiteLabelPlanModel.exists({
          accountId: account._id,
          status: "published",
          "price.taxBehavior": { $nin: ["exclusive", "inclusive"] },
        }),
        WhiteLabelSubscriptionModel.exists({
          accountId: account._id,
          status: { $nin: ["cancelled", "expired"] },
          "priceSnapshot.taxBehavior": { $nin: ["exclusive", "inclusive"] },
        }),
      ]);
      if (unspecifiedPlan || unspecifiedSubscription) {
        throw new HttpError(409, "A retail tax rate cannot be enabled until every published and assigned customer plan declares inclusive or exclusive tax behavior.");
      }
    }
    account.set("retailBilling", retailBilling);
  }
  if (request.body.modelAccess !== undefined) {
    account.set("modelAccess", parseWhiteLabelModelAccess(request.body.modelAccess));
  }
  await account.save();
  await recordPlatformAudit(request, {
    action: "white_label.commercials_updated",
    resource: "white_label_account",
    resourceId: account.id,
    accountId: account.id,
    targetOrgId: String(account.ownerOrgId),
    reason,
    before,
    after: account.toObject(),
  });
  response.json({ account });
}

export async function listPlatformAuditLogs(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
  const filter: Record<string, unknown> = {};
  const accountId = String(request.query.accountId ?? "");
  const action = String(request.query.action ?? "").trim();
  if (accountId) filter.accountId = accountId;
  if (action) filter.action = action;
  const [auditLogs, total] = await Promise.all([
    PlatformAuditLogModel.find(filter)
      .populate("actorUserId", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PlatformAuditLogModel.countDocuments(filter),
  ]);
  response.json({ auditLogs, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } });
}
