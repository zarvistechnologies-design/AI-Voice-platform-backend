import { createHash, randomBytes } from "node:crypto";
import { startSession, Types, type HydratedDocument } from "mongoose";
import type { Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { OrganizationModel } from "../models/Organization.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { UserModel } from "../models/User.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelBrandModel, type WhiteLabelBrand } from "../models/WhiteLabelBrand.js";
import { WhiteLabelDomainModel } from "../models/WhiteLabelDomain.js";
import { WhiteLabelPlanModel } from "../models/WhiteLabelPlan.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { ensureCreditWallet, recordCreditTopUp } from "../services/billingService.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { customerActivationEmail } from "../services/emailTemplates.js";
import {
  assertCustomerBelongsToAccount,
  createWhiteLabelDomain,
  emailBrandFromDocument,
  invalidateHostnameCache,
  isTransactionalSendingDomainVerified,
  normalizeSlug,
  publicPlanSnapshot,
  requirePartnerAccount,
  validateBrandAssetUrl,
  validateBrandColor,
  validateEmail,
  validateHttpsUrl,
  verifyWhiteLabelDomain,
} from "../services/whiteLabelService.js";
import {
  assertWhiteLabelModelAccessSubset,
  parseWhiteLabelModelAccess,
  whiteLabelModelCatalogForAccess,
  type WhiteLabelModelAccess,
} from "../services/whiteLabelModelAccessService.js";
import { HttpError } from "../utils/httpError.js";

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

function optionalText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function nextPlanPeriod(from: Date, interval: unknown) {
  const end = new Date(from);
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

function own(input: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function parseBrandInput(value: unknown, current?: Record<string, unknown>) {
  const input = (value ?? {}) as Record<string, unknown>;
  const currentBranding = (current?.branding ?? {}) as Record<string, unknown>;
  const currentSupport = (current?.support ?? {}) as Record<string, unknown>;
  const currentLegal = (current?.legal ?? {}) as Record<string, unknown>;
  const currentEmail = (current?.email ?? {}) as Record<string, unknown>;
  const branding = (input.branding ?? {}) as Record<string, unknown>;
  const support = (input.support ?? {}) as Record<string, unknown>;
  const legal = (input.legal ?? {}) as Record<string, unknown>;
  const email = (input.email ?? {}) as Record<string, unknown>;
  const nextFromAddress = validateEmail(
    own(email, "fromAddress") ? email.fromAddress : currentEmail.fromAddress,
    "Email from address",
  );
  const currentFromAddress = typeof currentEmail.fromAddress === "string"
    ? currentEmail.fromAddress.trim().toLowerCase()
    : "";
  const sendingDomainStatus = !nextFromAddress
    ? "not_configured"
    : nextFromAddress === currentFromAddress && currentEmail.sendingDomainStatus === "verified"
      ? "verified"
      : "pending";
  const defaultTheme = own(branding, "defaultTheme") ? branding.defaultTheme : currentBranding.defaultTheme ?? "dark";
  if (defaultTheme !== "light" && defaultTheme !== "dark" && defaultTheme !== "system") {
    throw new HttpError(400, "Default theme must be light, dark, or system.");
  }
  return {
    branding: {
      productName: text(own(branding, "productName") ? branding.productName : currentBranding.productName, "Product name", 2, 80),
      companyName: text(own(branding, "companyName") ? branding.companyName : currentBranding.companyName, "Company name", 2, 120),
      logoUrl: validateBrandAssetUrl(own(branding, "logoUrl") ? branding.logoUrl : currentBranding.logoUrl, "Logo URL"),
      logoDarkUrl: validateBrandAssetUrl(own(branding, "logoDarkUrl") ? branding.logoDarkUrl : currentBranding.logoDarkUrl, "Dark logo URL"),
      iconUrl: validateBrandAssetUrl(own(branding, "iconUrl") ? branding.iconUrl : currentBranding.iconUrl, "Icon URL"),
      primaryColor: validateBrandColor(own(branding, "primaryColor") ? branding.primaryColor : currentBranding.primaryColor ?? "#45ddce", "Primary color"),
      secondaryColor: validateBrandColor(own(branding, "secondaryColor") ? branding.secondaryColor : currentBranding.secondaryColor ?? "#071b18", "Secondary color"),
      accentColor: validateBrandColor(own(branding, "accentColor") ? branding.accentColor : currentBranding.accentColor ?? "#75fff0", "Accent color"),
      surfaceColor: validateBrandColor(own(branding, "surfaceColor") ? branding.surfaceColor : currentBranding.surfaceColor ?? "#020807", "Surface color"),
      defaultTheme,
      poweredByText: optionalText(own(branding, "poweredByText") ? branding.poweredByText : currentBranding.poweredByText ?? "Powered by Vozon", 120) || "Powered by Vozon",
    },
    support: {
      email: validateEmail(own(support, "email") ? support.email : currentSupport.email, "Support email"),
      phone: optionalText(own(support, "phone") ? support.phone : currentSupport.phone, 40),
      websiteUrl: validateHttpsUrl(own(support, "websiteUrl") ? support.websiteUrl : currentSupport.websiteUrl, "Website URL"),
      helpCenterUrl: validateHttpsUrl(own(support, "helpCenterUrl") ? support.helpCenterUrl : currentSupport.helpCenterUrl, "Help-center URL"),
      statusPageUrl: validateHttpsUrl(own(support, "statusPageUrl") ? support.statusPageUrl : currentSupport.statusPageUrl, "Status-page URL"),
    },
    legal: {
      termsUrl: validateHttpsUrl(own(legal, "termsUrl") ? legal.termsUrl : currentLegal.termsUrl, "Terms URL"),
      privacyUrl: validateHttpsUrl(own(legal, "privacyUrl") ? legal.privacyUrl : currentLegal.privacyUrl, "Privacy URL"),
      cookiePolicyUrl: validateHttpsUrl(own(legal, "cookiePolicyUrl") ? legal.cookiePolicyUrl : currentLegal.cookiePolicyUrl, "Cookie-policy URL"),
      legalBusinessName: optionalText(own(legal, "legalBusinessName") ? legal.legalBusinessName : currentLegal.legalBusinessName, 160),
      businessAddress: optionalText(own(legal, "businessAddress") ? legal.businessAddress : currentLegal.businessAddress, 500),
    },
    email: {
      fromName: optionalText(own(email, "fromName") ? email.fromName : currentEmail.fromName, 120),
      fromAddress: nextFromAddress,
      replyTo: validateEmail(own(email, "replyTo") ? email.replyTo : currentEmail.replyTo, "Reply-to address"),
      sendingDomainStatus,
    },
  };
}

function parsePlanInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  const price = (input.price ?? {}) as Record<string, unknown>;
  const usage = (input.usagePricing ?? {}) as Record<string, unknown>;
  const allowances = (input.allowances ?? {}) as Record<string, unknown>;
  const limits = (input.limits ?? {}) as Record<string, unknown>;
  const features = (input.features ?? {}) as Record<string, unknown>;
  const currency = String(price.currency ?? "USD").trim().toUpperCase();
  if (currency !== "USD" && currency !== "INR") {
    throw new HttpError(400, "Plan currency must be USD or INR until an audited FX feed is configured.");
  }
  const mode = usage.mode ?? "cost_markup";
  if (mode !== "cost_markup" && mode !== "fixed_per_minute" && mode !== "included_only") {
    throw new HttpError(400, "Invalid usage-pricing mode.");
  }
  const interval = price.interval === "year" ? "year" : "month";
  const taxBehavior = price.taxBehavior ?? "unspecified";
  if (taxBehavior !== "exclusive" && taxBehavior !== "inclusive" && taxBehavior !== "unspecified") {
    throw new HttpError(400, "Invalid tax behavior.");
  }
  const bool = (key: string, fallback: boolean) => typeof features[key] === "boolean" ? features[key] as boolean : fallback;
  return {
    key: normalizeSlug(input.key, input.name as string),
    name: text(input.name, "Plan name", 2, 100),
    description: optionalText(input.description, 1_000),
    isPublic: input.isPublic !== false,
    price: {
      currency,
      recurringAmountMinor: integer(price.recurringAmountMinor ?? 0, "Recurring amount", 0, 1_000_000_000_000),
      interval,
      setupFeeMinor: integer(price.setupFeeMinor ?? 0, "Setup fee", 0, 1_000_000_000_000),
      trialDays: integer(price.trialDays ?? 0, "Trial days", 0, 365),
      taxBehavior,
    },
    usagePricing: {
      mode,
      markupBps: integer(usage.markupBps ?? 0, "Usage markup", 0, 100_000),
      perMinuteAmountMinor: integer(usage.perMinuteAmountMinor ?? 0, "Per-minute amount", 0, 1_000_000_000),
      minimumCallAmountMinor: integer(usage.minimumCallAmountMinor ?? 0, "Minimum call amount", 0, 1_000_000_000),
      overageEnabled: usage.overageEnabled !== false,
    },
    allowances: {
      includedCredits: decimal(allowances.includedCredits ?? 0, "Included credits", 0, 1_000_000_000),
      includedMinutes: integer(allowances.includedMinutes ?? 0, "Included minutes", 0, 1_000_000_000),
    },
    limits: {
      agents: integer(limits.agents ?? 1, "Agent limit", 0, 100_000),
      members: integer(limits.members ?? 5, "Member limit", 1, 100_000),
      phoneNumbers: integer(limits.phoneNumbers ?? 1, "Phone-number limit", 0, 100_000),
      concurrentCalls: integer(limits.concurrentCalls ?? 1, "Concurrent-call limit", 0, 100_000),
      monthlyMinutes: integer(limits.monthlyMinutes ?? 100, "Monthly-minute limit", 0, 1_000_000_000),
      knowledgeSources: integer(limits.knowledgeSources ?? 10, "Knowledge-source limit", 0, 1_000_000),
      apiKeys: integer(limits.apiKeys ?? 1, "API-key limit", 0, 100_000),
    },
    features: {
      campaigns: bool("campaigns", true),
      inboundCalling: bool("inboundCalling", true),
      outboundCalling: bool("outboundCalling", true),
      callRecording: bool("callRecording", false),
      knowledgeBase: bool("knowledgeBase", true),
      integrations: bool("integrations", true),
      developerApi: bool("developerApi", false),
      advancedAnalytics: bool("advancedAnalytics", false),
      teamAccess: bool("teamAccess", true),
    },
    modelAccess: parseWhiteLabelModelAccess(input.modelAccess, { optional: true }),
  };
}

function verifyPlanAgainstAccount(plan: ReturnType<typeof parsePlanInput>, account: Awaited<ReturnType<typeof requirePartnerAccount>>) {
  if (plan.limits.agents > account.limits!.agentsPerCustomer) throw new HttpError(409, "Plan agent limit exceeds the platform contract.");
  if (plan.limits.members > account.limits!.membersPerCustomer) throw new HttpError(409, "Plan member limit exceeds the platform contract.");
  if (plan.limits.phoneNumbers > account.limits!.phoneNumbersPerCustomer) throw new HttpError(409, "Plan phone-number limit exceeds the platform contract.");
  if (plan.limits.concurrentCalls > account.limits!.concurrentCallsPerCustomer) throw new HttpError(409, "Plan concurrency exceeds the platform contract.");
  if (plan.limits.monthlyMinutes > account.limits!.monthlyMinutesPerCustomer) throw new HttpError(409, "Plan monthly minutes exceed the platform contract.");
  if (plan.features.developerApi && !account.entitlements!.developerApi) throw new HttpError(409, "Developer API is not included in the platform contract.");
  if (plan.features.advancedAnalytics && !account.entitlements!.advancedAnalytics) throw new HttpError(409, "Advanced analytics is not included in the platform contract.");
  assertWhiteLabelModelAccessSubset(
    plan.modelAccess,
    account.modelAccess as WhiteLabelModelAccess | undefined,
  );
  if (plan.usagePricing.mode === "fixed_per_minute" && plan.usagePricing.perMinuteAmountMinor <= 0) {
    throw new HttpError(400, "Fixed per-minute plans require a positive per-minute amount.");
  }
  if (account.retailBilling?.enabled && account.retailBilling.transferMode === "full_amount" && plan.price.currency !== "INR") {
    throw new HttpError(409, "Razorpay Route full-amount settlement supports INR customer plans only.");
  }
  if (
    account.retailBilling?.enabled
    && Number(account.retailBilling.taxRateBps ?? 0) > 0
    && plan.price.taxBehavior === "unspecified"
  ) {
    throw new HttpError(409, "Set this plan's tax behavior before using the configured retail tax rate.");
  }
}

function brandPublishReadiness(brand: HydratedDocument<WhiteLabelBrand> | null) {
  if (!brand) return ["brand"];
  const missing: string[] = [];
  if (!brand.branding!.logoUrl) missing.push("logo");
  if (!brand.branding!.iconUrl) missing.push("icon");
  if (!brand.support!.email) missing.push("support email");
  if (!brand.legal!.termsUrl) missing.push("terms URL");
  if (!brand.legal!.privacyUrl) missing.push("privacy URL");
  if (!brand.legal!.legalBusinessName) missing.push("legal business name");
  if (!brand.email!.fromAddress) {
    missing.push("email sender address");
  } else if (brand.email!.sendingDomainStatus !== "verified") {
    missing.push("verified email sending domain");
  }
  return missing;
}

export async function partnerWhiteLabelOverview(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const [brands, domains, plans, customerCount, activeSubscriptions] = await Promise.all([
    WhiteLabelBrandModel.find({ accountId: account._id }).sort({ isDefault: -1, createdAt: 1 }),
    WhiteLabelDomainModel.find({ accountId: account._id }).sort({ createdAt: -1 }),
    WhiteLabelPlanModel.find({ accountId: account._id }).sort({ key: 1, version: -1 }),
    OrganizationModel.countDocuments({ whiteLabelAccountId: account._id }),
    WhiteLabelSubscriptionModel.countDocuments({ accountId: account._id, status: { $in: ["trialing", "active", "past_due", "paused"] } }),
  ]);
  response.json({
    account,
    brands,
    domains,
    plans,
    metrics: { customerCount, activeSubscriptions },
    modelAccessCatalog: whiteLabelModelCatalogForAccess(
      account.modelAccess as WhiteLabelModelAccess | undefined,
    ),
  });
}

export async function partnerWhiteLabelEconomics(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const requestedFrom = request.query.from ? new Date(String(request.query.from)) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  if (Number.isNaN(requestedFrom.getTime())) throw new HttpError(400, "Economics start date is invalid.");
  const from = new Date(Math.max(requestedFrom.getTime(), Date.now() - 366 * 24 * 60 * 60_000));
  const organizations = await OrganizationModel.find({ whiteLabelAccountId: account._id }).select("_id name").lean();
  const orgIds = organizations.map((organization) => String(organization._id));
  const [usageRows, subscriptions] = await Promise.all([
    orgIds.length
      ? BillingTransactionModel.aggregate<{
          _id: string;
          customerUsageCharges: number;
          wholesaleCost: number;
          partnerMargin: number;
          calls: number;
        }>([
          { $match: { orgId: { $in: orgIds }, category: "call", createdAt: { $gte: from } } },
          { $sort: { createdAt: 1 } },
          { $group: { _id: "$callId", latest: { $last: "$$ROOT" } } },
          {
            $group: {
              _id: { $ifNull: ["$latest.breakdown.billingCurrency", "$latest.currency"] },
              customerUsageCharges: { $sum: { $ifNull: ["$latest.breakdown.customerCost", 0] } },
              wholesaleCost: { $sum: { $ifNull: ["$latest.breakdown.wholesaleCost", 0] } },
              partnerMargin: { $sum: { $ifNull: ["$latest.breakdown.partnerMargin", 0] } },
              calls: { $sum: 1 },
            },
          },
        ])
      : [],
    WhiteLabelSubscriptionModel.find({
      accountId: account._id,
      status: { $in: ["trialing", "active", "past_due", "paused"] },
    }).select("status priceSnapshot").lean(),
  ]);
  const recurringByCurrency = new Map<string, number>();
  for (const subscription of subscriptions) {
    const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
    const currency = price.currency === "INR" ? "INR" : "USD";
    const recurringMinor = Math.max(0, Number(price.recurringAmountMinor ?? 0));
    const monthlyMinor = price.interval === "year" ? recurringMinor / 12 : recurringMinor;
    recurringByCurrency.set(currency, (recurringByCurrency.get(currency) ?? 0) + monthlyMinor);
  }
  const currencies = new Set([...usageRows.map((row) => String(row._id || "USD")), ...recurringByCurrency.keys()]);
  response.json({
    from,
    activeSubscriptionCount: subscriptions.length,
    economics: [...currencies].sort().map((currency) => {
      const usage = usageRows.find((row) => String(row._id || "USD") === currency);
      return {
        currency,
        projectedMonthlyRecurringMinor: Math.round((recurringByCurrency.get(currency) ?? 0) * 100) / 100,
        customerUsageCharges: Math.round(Number(usage?.customerUsageCharges ?? 0) * 1_000_000) / 1_000_000,
        wholesaleCost: Math.round(Number(usage?.wholesaleCost ?? 0) * 1_000_000) / 1_000_000,
        partnerMargin: Math.round(Number(usage?.partnerMargin ?? 0) * 1_000_000) / 1_000_000,
        calls: Number(usage?.calls ?? 0),
      };
    }),
  });
}

export async function createPartnerBrand(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const existingCount = await WhiteLabelBrandModel.countDocuments({ accountId: account._id });
  if (!account.entitlements!.multipleBrands && existingCount >= 1) {
    throw new HttpError(403, "Multiple brands are not included in this account.");
  }
  const parsed = parseBrandInput(request.body);
  const brandId = new Types.ObjectId();
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      // Synchronize legacy accounts that predate the durable counter, then use
      // one atomic reservation so concurrent creates cannot exceed the limit.
      await WhiteLabelAccountModel.updateOne(
        { _id: account._id },
        { $max: { "usage.brands": existingCount } },
        { session },
      );
      const reserved = await WhiteLabelAccountModel.findOneAndUpdate(
        {
          _id: account._id,
          status: { $ne: "terminated" },
          $expr: {
            $lt: [
              { $ifNull: ["$usage.brands", existingCount] },
              { $ifNull: ["$limits.brands", 1] },
            ],
          },
        },
        { $inc: { "usage.brands": 1 } },
        { new: true, session },
      );
      if (!reserved) throw new HttpError(409, "Brand limit reached.");
      await WhiteLabelBrandModel.create([{
        _id: brandId,
        accountId: account._id,
        key: normalizeSlug(request.body.key, parsed.branding.productName),
        status: "draft",
        isDefault: existingCount === 0,
        ...parsed,
      }], { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new HttpError(409, "Brand key is already in use.");
    throw error;
  } finally {
    await session.endSession();
  }
  const brand = await WhiteLabelBrandModel.findById(brandId);
  if (!brand) throw new Error("Brand creation transaction completed without a result.");
  await recordAuditLog(request, {
    action: "white_label.brand_created",
    resource: "white_label_brand",
    resourceId: brand.id,
    after: brand.toObject(),
  });
  response.status(201).json({ brand });
}

export async function updatePartnerBrand(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const brand = await WhiteLabelBrandModel.findOne({ _id: request.params.brandId, accountId: account._id });
  if (!brand) throw new HttpError(404, "Brand not found.");
  if (brand.status === "disabled") throw new HttpError(409, "Disabled brands cannot be edited.");
  const before = brand.toObject();
  const parsed = parseBrandInput(request.body, before as unknown as Record<string, unknown>);
  brand.set(parsed);
  await brand.save();
  const domainHostnames = await WhiteLabelDomainModel.find({ brandId: brand._id }).distinct("hostname");
  for (const hostname of domainHostnames) invalidateHostnameCache(hostname);
  await recordAuditLog(request, {
    action: "white_label.brand_updated",
    resource: "white_label_brand",
    resourceId: brand.id,
    before,
    after: brand.toObject(),
  });
  response.json({ brand });
}

export async function uploadPartnerBrandAsset(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  if (!env.cloudflareAccountId || !env.cloudflareApiToken) {
    throw new HttpError(503, "Cloudflare Images is not configured for managed brand uploads.");
  }
  const upload = (request as AuthenticatedRequest & { file?: Express.Multer.File }).file;
  if (!upload) throw new HttpError(400, "Choose a raster image to upload.");
  const role = String(request.body.role ?? "");
  const field = role === "logo" ? "logoUrl" : role === "logoDark" ? "logoDarkUrl" : role === "icon" ? "iconUrl" : "";
  if (!field) throw new HttpError(400, "Asset role must be logo, logoDark, or icon.");
  const brand = await WhiteLabelBrandModel.findOne({ _id: request.params.brandId, accountId: account._id });
  if (!brand) throw new HttpError(404, "Brand not found.");
  if (brand.status === "disabled") throw new HttpError(409, "Disabled brands cannot accept uploads.");
  const bytes = new Uint8Array(upload.buffer);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: upload.mimetype }), upload.originalname.slice(0, 255));
  form.set("creator", request.user?.id ?? "partner");
  form.set("requireSignedURLs", "false");
  form.set("metadata", JSON.stringify({ accountId: account.id, brandId: brand.id, role: field }));
  const cloudflareResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.cloudflareAccountId)}/images/v1`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.cloudflareApiToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await cloudflareResponse.json().catch(() => null) as {
    success?: boolean;
    result?: { id?: string; variants?: string[] };
    errors?: Array<{ message?: string }>;
  } | null;
  const assetUrl = payload?.result?.variants?.find((value) => value.endsWith("/public"))
    ?? payload?.result?.variants?.[0]
    ?? "";
  if (!cloudflareResponse.ok || !payload?.success || !assetUrl) {
    throw new HttpError(502, payload?.errors?.[0]?.message ?? "Cloudflare Images upload failed.");
  }
  const validatedUrl = validateBrandAssetUrl(assetUrl, "Uploaded brand asset", false);
  const before = { [field]: brand.branding?.[field as keyof typeof brand.branding] };
  brand.set(`branding.${field}`, validatedUrl);
  await brand.save();
  const hostnames = await WhiteLabelDomainModel.find({ brandId: brand._id }).distinct("hostname");
  for (const hostname of hostnames) invalidateHostnameCache(hostname);
  await recordAuditLog(request, {
    action: "white_label.brand_asset_uploaded",
    resource: "white_label_brand",
    resourceId: brand.id,
    before,
    after: { field, assetUrl: validatedUrl, cloudflareImageId: payload.result?.id ?? "" },
  });
  response.status(201).json({ brand, field, assetUrl: validatedUrl });
}

export async function publishPartnerBrand(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const brand = await WhiteLabelBrandModel.findOne({ _id: request.params.brandId, accountId: account._id });
  if (!brand) throw new HttpError(404, "Brand not found.");
  if (brand.status === "disabled") throw new HttpError(409, "Disabled brands cannot be published.");
  const missing = brandPublishReadiness(brand);
  if (missing.length) throw new HttpError(409, `Complete these brand settings before publishing: ${missing.join(", ")}.`);
  const before = { status: brand.status, publishedAt: brand.publishedAt };
  brand.status = "published";
  brand.publishedAt = brand.publishedAt ?? new Date();
  await brand.save();
  await recordAuditLog(request, {
    action: "white_label.brand_published",
    resource: "white_label_brand",
    resourceId: brand.id,
    before,
    after: { status: brand.status, publishedAt: brand.publishedAt },
  });
  response.json({ brand });
}

export async function verifyPartnerBrandEmailDomain(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const brand = await WhiteLabelBrandModel.findOne({
    _id: request.params.brandId,
    accountId: account._id,
  });
  if (!brand) throw new HttpError(404, "White-label brand not found.");
  const fromAddress = brand.email!.fromAddress?.trim().toLowerCase() ?? "";
  if (!fromAddress) throw new HttpError(400, "Configure the branded sender address before verification.");
  const verified = await isTransactionalSendingDomainVerified(fromAddress);
  brand.email!.sendingDomainStatus = verified ? "verified" : "failed";
  await brand.save();
  await recordAuditLog(request, {
    action: "white_label.email_domain_verified",
    resource: "white_label_brand",
    resourceId: brand.id,
    after: { fromAddress, sendingDomainStatus: brand.email!.sendingDomainStatus },
  });
  if (!verified) {
    throw new HttpError(409, "The sender domain is not verified with the configured email provider yet.");
  }
  response.json({ brand });
}

export async function addPartnerDomain(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const kind = request.body.kind === "api" || request.body.kind === "link" ? request.body.kind : "app";
  const domain = await createWhiteLabelDomain({
    account,
    brandId: String(request.body.brandId ?? ""),
    hostname: String(request.body.hostname ?? ""),
    kind,
  });
  if (!domain) throw new Error("Domain provisioning completed without a result.");
  await recordAuditLog(request, {
    action: "white_label.domain_added",
    resource: "white_label_domain",
    resourceId: domain.id,
    after: { hostname: domain.hostname, kind: domain.kind, status: domain.status },
  });
  response.status(201).json({ domain });
}

export async function verifyPartnerDomain(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const before = await WhiteLabelDomainModel.findOne({ _id: request.params.domainId, accountId: account._id });
  if (!before) throw new HttpError(404, "Domain not found.");
  const domain = await verifyWhiteLabelDomain(account.id, before.id);
  await recordAuditLog(request, {
    action: "white_label.domain_verified",
    resource: "white_label_domain",
    resourceId: before.id,
    before: { status: before.status },
    after: { status: domain?.status, ownershipVerifiedAt: domain?.ownershipVerifiedAt, routingVerifiedAt: domain?.routingVerifiedAt },
  });
  response.json({ domain });
}

export async function disablePartnerDomain(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const reason = String(request.body.reason ?? "").trim();
  if (reason.length < 8 || reason.length > 2_000) throw new HttpError(400, "A reason of at least 8 characters is required.");
  const domain = await WhiteLabelDomainModel.findOne({ _id: request.params.domainId, accountId: account._id });
  if (!domain) throw new HttpError(404, "Domain not found.");
  if (domain.status === "disabled") throw new HttpError(409, "Domain is already disabled.");
  const before = { status: domain.status, hostname: domain.hostname };
  domain.status = "disabled";
  domain.failureReason = reason;
  domain.disabledAt = new Date();
  domain.nextCheckAt = undefined;
  await domain.save();
  invalidateHostnameCache(domain.hostname);
  await recordAuditLog(request, {
    action: "white_label.domain_disabled",
    resource: "white_label_domain",
    resourceId: domain.id,
    before,
    after: { status: domain.status, reason },
  });
  response.json({ domain });
}

export async function createPartnerPlan(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  if (!account.entitlements!.customCustomerPricing) throw new HttpError(403, "Custom customer pricing is not included.");
  const parsed = parsePlanInput(request.body);
  verifyPlanAgainstAccount(parsed, account);
  let plan;
  try {
    plan = await WhiteLabelPlanModel.create({ accountId: account._id, version: 1, status: "draft", ...parsed });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new HttpError(409, "A plan with this key already exists. Revise the existing plan instead.");
    throw error;
  }
  await recordAuditLog(request, {
    action: "white_label.plan_created",
    resource: "white_label_plan",
    resourceId: plan.id,
    after: plan.toObject(),
  });
  response.status(201).json({ plan });
}

export async function updatePartnerPlan(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const plan = await WhiteLabelPlanModel.findOne({ _id: request.params.planId, accountId: account._id });
  if (!plan) throw new HttpError(404, "Plan not found.");
  if (plan.status !== "draft") throw new HttpError(409, "Published and archived plans are immutable. Create a revision instead.");
  const current = plan.toObject() as unknown as Record<string, unknown>;
  const patch = (request.body ?? {}) as Record<string, unknown>;
  const mergeSection = (key: string) => ({
    ...((current[key] ?? {}) as Record<string, unknown>),
    ...((patch[key] ?? {}) as Record<string, unknown>),
  });
  const parsed = parsePlanInput({
    ...current,
    ...patch,
    key: plan.key,
    price: mergeSection("price"),
    usagePricing: mergeSection("usagePricing"),
    allowances: mergeSection("allowances"),
    limits: mergeSection("limits"),
    features: mergeSection("features"),
    ...((patch.modelAccess !== undefined || current.modelAccess)
      ? { modelAccess: mergeSection("modelAccess") }
      : {}),
  });
  verifyPlanAgainstAccount(parsed, account);
  const before = plan.toObject();
  plan.set(parsed);
  await plan.save();
  await recordAuditLog(request, {
    action: "white_label.plan_updated",
    resource: "white_label_plan",
    resourceId: plan.id,
    before,
    after: plan.toObject(),
  });
  response.json({ plan });
}

export async function publishPartnerPlan(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const plan = await WhiteLabelPlanModel.findOne({ _id: request.params.planId, accountId: account._id });
  if (!plan) throw new HttpError(404, "Plan not found.");
  if (plan.status !== "draft") throw new HttpError(409, "Only draft plans can be published.");
  const parsed = parsePlanInput(plan.toObject());
  verifyPlanAgainstAccount(parsed, account);
  plan.status = "published";
  plan.publishedAt = new Date();
  await plan.save();
  await recordAuditLog(request, {
    action: "white_label.plan_published",
    resource: "white_label_plan",
    resourceId: plan.id,
    after: { key: plan.key, version: plan.version, publishedAt: plan.publishedAt },
  });
  response.json({ plan });
}

export async function revisePartnerPlan(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const source = await WhiteLabelPlanModel.findOne({ _id: request.params.planId, accountId: account._id });
  if (!source) throw new HttpError(404, "Plan not found.");
  if (source.status !== "published" && source.status !== "archived") {
    throw new HttpError(409, "Only published or archived plans can be revised.");
  }
  const newest = await WhiteLabelPlanModel.findOne({ accountId: account._id, key: source.key }).sort({ version: -1 });
  if (newest?.status === "draft") throw new HttpError(409, "A draft revision already exists for this plan.");
  const sourceObject = source.toObject() as unknown as Record<string, unknown>;
  delete sourceObject._id;
  delete sourceObject.createdAt;
  delete sourceObject.updatedAt;
  delete sourceObject.publishedAt;
  delete sourceObject.archivedAt;
  const plan = await WhiteLabelPlanModel.create({
    ...sourceObject,
    version: (newest?.version ?? source.version) + 1,
    status: "draft",
  });
  await recordAuditLog(request, {
    action: "white_label.plan_revision_created",
    resource: "white_label_plan",
    resourceId: plan.id,
    before: { sourcePlanId: source.id, sourceVersion: source.version },
    after: { key: plan.key, version: plan.version },
  });
  response.status(201).json({ plan });
}

export async function archivePartnerPlan(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const plan = await WhiteLabelPlanModel.findOne({ _id: request.params.planId, accountId: account._id });
  if (!plan) throw new HttpError(404, "Plan not found.");
  if (plan.status !== "published") throw new HttpError(409, "Only published plans can be archived.");
  plan.status = "archived";
  plan.archivedAt = new Date();
  await plan.save();
  await recordAuditLog(request, {
    action: "white_label.plan_archived",
    resource: "white_label_plan",
    resourceId: plan.id,
    after: { key: plan.key, version: plan.version, archivedAt: plan.archivedAt },
  });
  response.json({ plan });
}

export async function listPartnerCustomers(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 25));
  const filter: Record<string, unknown> = { whiteLabelAccountId: account._id };
  const status = String(request.query.status ?? "");
  if (status) filter.lifecycleStatus = status;
  const [organizations, total] = await Promise.all([
    OrganizationModel.find(filter)
      .populate("ownerUserId", "name email emailVerified lastLoginAt")
      .populate("whiteLabelBrandId", "key branding.productName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    OrganizationModel.countDocuments(filter),
  ]);
  const orgIds = organizations.map((organization) => organization._id);
  const subscriptions = await WhiteLabelSubscriptionModel.find({ orgId: { $in: orgIds } });
  const subscriptionByOrg = new Map(subscriptions.map((subscription) => [String(subscription.orgId), subscription]));
  response.json({
    customers: organizations.map((organization) => ({
      ...organization.toObject(),
      subscription: subscriptionByOrg.get(organization.id) ?? null,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
}

export async function provisionPartnerCustomer(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  if (account.status !== "active") throw new HttpError(409, "The white-label account must be active before customers can be provisioned.");
  const organizationName = text(request.body.organizationName, "Organization name", 2, 100);
  const ownerEmail = validateEmail(request.body.ownerEmail, "Owner email", false);
  const ownerName = text(request.body.ownerName ?? ownerEmail.split("@")[0], "Owner name", 2, 80);
  const externalCustomerId = optionalText(request.body.externalCustomerId, 200);
  const brandId = String(request.body.brandId ?? "");
  const planId = String(request.body.planId ?? "");
  if (!Types.ObjectId.isValid(brandId) || !Types.ObjectId.isValid(planId)) {
    throw new HttpError(400, "A valid brand and plan are required.");
  }
  const [owner, brand, plan] = await Promise.all([
    UserModel.findOne({ email: ownerEmail }),
    WhiteLabelBrandModel.findOne({ _id: brandId, accountId: account._id, status: "published" }),
    WhiteLabelPlanModel.findOne({ _id: planId, accountId: account._id, status: "published" }),
  ]);
  if (!brand) throw new HttpError(404, "Published brand not found.");
  if (!plan) throw new HttpError(404, "Published plan not found.");
  verifyPlanAgainstAccount(parsePlanInput(plan.toObject()), account);
  const activeDomain = await WhiteLabelDomainModel.findOne({
    accountId: account._id,
    brandId: brand._id,
    kind: "app",
    status: "active",
  }).sort({ activatedAt: 1 });
  if (!activeDomain) throw new HttpError(409, "Activate an app domain for this brand before provisioning customers.");
  const ownerId = owner?._id ?? new Types.ObjectId();
  const existing = await OrganizationModel.exists({ ownerUserId: ownerId, whiteLabelAccountId: account._id });
  if (existing) throw new HttpError(409, "This owner already has a customer organization under your account.");
  const snapshots = publicPlanSnapshot(
    plan,
    account.modelAccess as WhiteLabelModelAccess | undefined,
  );
  const slug = `${normalizeSlug(organizationName, "customer").slice(0, 48)}-${randomBytes(4).toString("hex")}`;
  const session = await startSession();
  const organizationId = new Types.ObjectId();
  const subscriptionId = new Types.ObjectId();
  const activationToken = owner?.emailVerified ? "" : randomBytes(32).toString("hex");
  const activationExpiresAt = activationToken ? new Date(Date.now() + 72 * 60 * 60 * 1000) : undefined;
  try {
    await session.withTransaction(async () => {
      const reserved = await WhiteLabelAccountModel.findOneAndUpdate(
        {
          _id: account._id,
          status: "active",
          "usage.customerOrganizations": { $lt: account.limits!.customerOrganizations },
        },
        { $inc: { "usage.customerOrganizations": 1 } },
        { new: true, session },
      );
      if (!reserved) throw new HttpError(409, "Customer organization limit reached.");
      if (!owner) {
        await UserModel.create([{
          _id: ownerId,
          name: ownerName,
          email: ownerEmail,
          emailVerified: false,
          passwordResetTokenHash: createHash("sha256").update(activationToken).digest("hex"),
          passwordResetExpires: activationExpiresAt,
        }], { session });
      } else if (activationToken) {
        await UserModel.updateOne(
          { _id: ownerId },
          {
            $set: {
              name: ownerName,
              passwordResetTokenHash: createHash("sha256").update(activationToken).digest("hex"),
              passwordResetExpires: activationExpiresAt,
            },
          },
          { session },
        );
      }
      await OrganizationModel.create([{
        _id: organizationId,
        name: organizationName,
        slug,
        ownerUserId: ownerId,
        whiteLabelAccountId: account._id,
        whiteLabelBrandId: brand._id,
        lifecycleStatus: "active",
        provisioningSource: "partner",
        externalCustomerId,
        plan: "free",
      }], { session });
      await OrganizationMemberModel.create([{
        orgId: organizationId,
        userId: ownerId,
        role: "owner",
      }], { session });
      const now = new Date();
      const trialEndsAt = plan.price!.trialDays
        ? new Date(now.getTime() + plan.price!.trialDays * 24 * 60 * 60_000)
        : undefined;
      await WhiteLabelSubscriptionModel.create([{
        _id: subscriptionId,
        accountId: account._id,
        brandId: brand._id,
        orgId: organizationId,
        planId: plan._id,
        planKey: plan.key,
        planVersion: plan.version,
        status: trialEndsAt ? "trialing" : account.retailBilling?.enabled ? "incomplete" : "active",
        priceSnapshot: snapshots.price,
        usagePricingSnapshot: snapshots.usagePricing,
        allowancesSnapshot: snapshots.allowances,
        limitsSnapshot: snapshots.limits,
        featuresSnapshot: snapshots.features,
        modelAccessSnapshot: snapshots.modelAccess,
        provider: account.retailBilling?.enabled ? "razorpay" : "internal",
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt ?? nextPlanPeriod(now, plan.price!.interval),
        trialEndsAt,
      }], { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
  const [organization, subscription] = await Promise.all([
    OrganizationModel.findById(organizationId),
    WhiteLabelSubscriptionModel.findById(subscriptionId),
  ]);
  if (!organization || !subscription) throw new Error("Customer provisioning transaction completed without a result.");
  await ensureCreditWallet(organization.id);
  const includedCredits = Number(plan.allowances?.includedCredits ?? 0);
  if (includedCredits > 0 && (!account.retailBilling?.enabled || subscription.status === "trialing")) {
    await recordCreditTopUp({
      orgId: organization.id,
      amountCredits: includedCredits,
      paymentProvider: "internal",
      idempotencyKey: `white-label-subscription:${subscription.id}:initial-allowance`,
      description: `${plan.name} included voice credits`,
    });
  }
  const activationUrl = activationToken
    ? `https://${activeDomain.hostname}/reset-password?token=${activationToken}`
    : `https://${activeDomain.hostname}/login`;
  const emailContent = customerActivationEmail({
    brand: emailBrandFromDocument(brand),
    organizationName,
    recipientName: ownerName,
    activationUrl,
    expiresAt: activationExpiresAt,
    existingAccount: Boolean(owner?.emailVerified),
  });
  let emailDeliveryStatus: "sent" | "preview" | "failed" = "failed";
  try {
    const delivery = await sendTransactionalEmail({
      userId: String(ownerId),
      to: ownerEmail,
      replyTo: brand.support!.email || undefined,
      fromName: brand.email!.fromName || brand.branding!.productName,
      fromAddress: brand.email!.sendingDomainStatus === "verified"
        ? brand.email!.fromAddress || undefined
        : undefined,
      requireVerifiedFromAddress: true,
      kind: "invitation",
      ...emailContent,
    });
    emailDeliveryStatus = delivery.status;
  } catch (error) {
    console.error("Customer activation email delivery failed.", error);
  }
  await recordAuditLog(request, {
    action: "white_label.customer_provisioned",
    resource: "organization",
    resourceId: organization.id,
    after: {
      organizationId: organization.id,
      ownerEmail,
      brandId: brand.id,
      planId: plan.id,
      planVersion: plan.version,
    },
  });
  response.status(201).json({
    organization,
    subscription,
    emailDeliveryStatus,
    ...(emailDeliveryStatus !== "sent" ? { activationUrl } : {}),
  });
}

export async function updatePartnerCustomerStatus(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const status = String(request.body.status ?? "");
  const reason = String(request.body.reason ?? "").trim();
  if (status !== "active" && status !== "suspended") throw new HttpError(400, "Status must be active or suspended.");
  if (reason.length < 8 || reason.length > 2_000) throw new HttpError(400, "A reason of at least 8 characters is required.");
  const organization = await assertCustomerBelongsToAccount(account.id, request.params.orgId);
  if (organization.lifecycleStatus === "archived") throw new HttpError(409, "Archived customers cannot be reactivated.");
  const before = { lifecycleStatus: organization.lifecycleStatus };
  organization.lifecycleStatus = status;
  await organization.save();
  await recordAuditLog(request, {
    action: `white_label.customer_${status}`,
    resource: "organization",
    resourceId: organization.id,
    before,
    after: { lifecycleStatus: organization.lifecycleStatus, reason },
  });
  response.json({ organization });
}

export async function updatePartnerCustomerSubscription(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const organization = await assertCustomerBelongsToAccount(account.id, request.params.orgId);
  const status = String(request.body.status ?? "");
  const reason = String(request.body.reason ?? "").trim();
  if (!["active", "past_due", "paused", "cancelled"].includes(status)) {
    throw new HttpError(400, "Subscription status must be active, past_due, paused, or cancelled.");
  }
  if (reason.length < 8 || reason.length > 2_000) throw new HttpError(400, "A reason of at least 8 characters is required.");
  const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId: organization._id, accountId: account._id });
  if (!subscription) throw new HttpError(404, "Customer subscription not found.");
  if (account.retailBilling?.enabled && status === "active") {
    throw new HttpError(409, "Retail-billed subscriptions become active only after a verified payment or a zero-value invoice settlement.");
  }
  const before = subscription.toObject();
  subscription.status = status as typeof subscription.status;
  if (status === "active") {
    const now = new Date();
    const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = nextPlanPeriod(now, price.interval);
    subscription.trialEndsAt = undefined;
    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = undefined;
    subscription.cancellationReason = "";
  } else if (status === "cancelled") {
    subscription.cancelledAt = new Date();
    subscription.cancellationReason = reason;
  }
  await subscription.save();
  await recordAuditLog(request, {
    action: `white_label.subscription_${status}`,
    resource: "white_label_subscription",
    resourceId: subscription.id,
    before,
    after: { ...subscription.toObject(), reason },
  });
  response.json({ subscription });
}
