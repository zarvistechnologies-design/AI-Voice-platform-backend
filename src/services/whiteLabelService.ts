import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
import type { HydratedDocument } from "mongoose";

import { env } from "../config/env.js";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { OrganizationModel } from "../models/Organization.js";
import { PlatformAuditLogModel } from "../models/PlatformAuditLog.js";
import {
  WhiteLabelAccountModel,
  type WhiteLabelAccount,
} from "../models/WhiteLabelAccount.js";
import { WhiteLabelBrandModel, type WhiteLabelBrand } from "../models/WhiteLabelBrand.js";
import { WhiteLabelDomainModel } from "../models/WhiteLabelDomain.js";
import type { WhiteLabelPlan } from "../models/WhiteLabelPlan.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import type { EmailBrand } from "./emailTemplates.js";
import { HttpError } from "../utils/httpError.js";
import {
  effectiveWhiteLabelModelAccess,
  type WhiteLabelModelAccess,
} from "./whiteLabelModelAccessService.js";

const hostnameCache = new Map<string, { expiresAt: number; value: PublicBrandConfig | null }>();
const HOSTNAME_CACHE_TTL_MS = 30_000;

export type PublicBrandConfig = {
  source: "platform" | "white_label";
  hostname: string;
  productName: string;
  companyName: string;
  logoUrl: string;
  logoDarkUrl: string;
  iconUrl: string;
  urls: {
    app: string;
    api: string;
    links: string;
  };
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    surface: string;
  };
  defaultTheme: "light" | "dark" | "system";
  support: {
    email: string;
    phone: string;
    websiteUrl: string;
    helpCenterUrl: string;
    statusPageUrl: string;
  };
  legal: {
    termsUrl: string;
    privacyUrl: string;
    cookiePolicyUrl: string;
    legalBusinessName: string;
    businessAddress: string;
  };
  poweredBy: { visible: boolean; text: string };
  authentication: { registrationMode: "invite_only" | "open"; googleSignIn: boolean };
};

export type WhiteLabelRequestContext = {
  accountId: string;
  brandId: string;
  productName: string;
  hostname: string;
  origin: string;
  apiOrigin: string;
  linkOrigin: string;
  registrationMode: "invite_only" | "open";
  allowGoogleSignIn: boolean;
  requireEmailVerification: boolean;
};

type CloudflareCustomHostname = {
  id?: string;
  hostname?: string;
  status?: string;
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    issuer?: string;
    expires_on?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string; cname?: string; cname_target?: string }>;
  };
};

function compact(value: unknown) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cleanDnsValue(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function safeHostnameFromUrl(value: string) {
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    return "";
  }
}

export function normalizeHostname(value: unknown) {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!raw || raw.includes("://") || /[\s/?#@:*]/.test(raw)) {
    throw new HttpError(400, "Enter a hostname only, such as app.example.com.");
  }
  const hostname = domainToASCII(raw).toLowerCase();
  if (!hostname || hostname.length > 253 || isIP(hostname) || hostname === "localhost") {
    throw new HttpError(400, "Enter a valid public hostname.");
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new HttpError(400, "Enter a valid public hostname.");
  }
  return hostname;
}

export function isPlatformHostname(value: unknown) {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") : "";
  if (!raw) return false;
  return env.platformHosts.includes(domainToASCII(raw));
}

export function normalizeSlug(value: unknown, fallback: string) {
  const slug = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (slug.length < 2) throw new HttpError(400, "Slug must contain at least two letters or numbers.");
  return slug;
}

export function validateHttpsUrl(value: unknown, field: string, allowEmpty = true) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized && allowEmpty) return "";
  if (normalized.length > 2_000) throw new HttpError(400, `${field} is too long.`);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new HttpError(400, `${field} must be a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new HttpError(400, `${field} must use HTTPS and cannot contain credentials.`);
  }
  return url.toString();
}

export function validateBrandAssetUrl(value: unknown, field: string, allowEmpty = true) {
  const normalized = validateHttpsUrl(value, field, allowEmpty);
  if (!normalized) return "";
  const url = new URL(normalized);
  const hostname = domainToASCII(url.hostname).toLowerCase();
  if (
    !hostname
    || isIP(hostname)
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    throw new HttpError(400, `${field} must be hosted on a public HTTPS domain.`);
  }
  if (hostname !== "imagedelivery.net" && !/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i.test(url.pathname)) {
    throw new HttpError(400, `${field} must point to an AVIF, GIF, ICO, JPEG, PNG, SVG, or WebP image.`);
  }
  return url.toString();
}

export function validateBrandColor(value: unknown, field: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(normalized)) {
    throw new HttpError(400, `${field} must be a six- or eight-digit hex color.`);
  }
  return normalized;
}

export function validateEmail(value: unknown, field: string, allowEmpty = true) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized && allowEmpty) return "";
  if (normalized.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new HttpError(400, `${field} must be a valid email address.`);
  }
  return normalized;
}

export async function isTransactionalSendingDomainVerified(fromAddress: string) {
  if (!env.resendApiKey) {
    throw new HttpError(503, "Branded sending-domain verification requires the configured Resend provider.");
  }
  const domain = fromAddress.split("@")[1]?.trim().toLowerCase();
  if (!domain) throw new HttpError(400, "Configure a valid branded sender address first.");
  const response = await fetch("https://api.resend.com/domains?limit=100", {
    headers: { Authorization: `Bearer ${env.resendApiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ name?: string; status?: string }>;
    message?: string;
  } | null;
  if (!response.ok) {
    throw new HttpError(502, payload?.message || `Email provider returned HTTP ${response.status}.`);
  }
  return Boolean(
    payload?.data?.some((item) =>
      item.name?.trim().toLowerCase() === domain && item.status?.toLowerCase() === "verified",
    ),
  );
}

export async function recordPlatformAudit(
  request: AuthenticatedRequest,
  input: {
    action: string;
    resource: string;
    resourceId?: string;
    accountId?: string;
    targetOrgId?: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  if (!request.user) throw new HttpError(401, "Authentication required.");
  await PlatformAuditLogModel.create({
    actorType: "user",
    actorUserId: request.user.id,
    actorEmail: request.user.email,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? "",
    accountId: input.accountId,
    targetOrgId: input.targetOrgId,
    reason: input.reason ?? "",
    before: compact(input.before),
    after: compact(input.after),
    requestId: (request as AuthenticatedRequest & { requestId?: string }).requestId ?? "",
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? "").slice(0, 1_000),
  });
}

export async function accountForOwnerOrganization(orgId: string) {
  return WhiteLabelAccountModel.findOne({ ownerOrgId: orgId });
}

export async function requirePartnerAccount(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Organization context required.");
  const account = await accountForOwnerOrganization(request.organization.id);
  if (!account) throw new HttpError(404, "White-label access has not been enabled for this organization.");
  if (account.status === "suspended" || account.status === "terminated") {
    throw new HttpError(403, "This white-label account is not active.");
  }
  return account;
}

export function publicPlanSnapshot(
  plan: HydratedDocument<WhiteLabelPlan> | WhiteLabelPlan,
  accountModelAccess?: WhiteLabelModelAccess,
) {
  const object = "toObject" in plan && typeof plan.toObject === "function" ? plan.toObject() : plan;
  return {
    price: compact(object.price),
    usagePricing: compact(object.usagePricing),
    allowances: compact(object.allowances),
    limits: compact(object.limits),
    features: compact(object.features),
    modelAccess: effectiveWhiteLabelModelAccess(
      object.modelAccess as WhiteLabelModelAccess | undefined,
      accountModelAccess,
    ),
  };
}

function cloudflareConfigured() {
  return Boolean(env.cloudflareApiToken && env.cloudflareZoneId);
}

async function cloudflareRequest(path: string, init: RequestInit = {}) {
  if (!cloudflareConfigured()) throw new HttpError(503, "Custom hostname edge provisioning is not configured.");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.cloudflareApiToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: CloudflareCustomHostname;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!response.ok || !data?.success || !data.result) {
    const detail = data?.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new HttpError(502, detail || `Custom hostname provider returned HTTP ${response.status}.`);
  }
  return data.result;
}

function providerValidationRecords(result: CloudflareCustomHostname) {
  const records: Array<{ type: "TXT" | "CNAME"; name: string; value: string; purpose: "certificate" }> = [];
  const ownership = result.ownership_verification;
  if (ownership?.type === "txt" && ownership.name && ownership.value) {
    records.push({ type: "TXT", name: cleanDnsValue(ownership.name), value: ownership.value, purpose: "certificate" });
  }
  for (const validation of result.ssl?.validation_records ?? []) {
    if (validation.txt_name && validation.txt_value) {
      records.push({
        type: "TXT",
        name: cleanDnsValue(validation.txt_name),
        value: validation.txt_value,
        purpose: "certificate",
      });
    } else if (validation.cname && validation.cname_target) {
      records.push({
        type: "CNAME",
        name: cleanDnsValue(validation.cname),
        value: cleanDnsValue(validation.cname_target),
        purpose: "certificate",
      });
    }
  }
  return records;
}

export async function createWhiteLabelDomain(input: {
  account: HydratedDocument<WhiteLabelAccount>;
  brandId: string;
  hostname: string;
  kind: "app" | "api" | "link";
}) {
  if (!env.whiteLabelEnabled) throw new HttpError(503, "White-label custom domains are not enabled.");
  if (!env.whiteLabelCnameTarget) throw new HttpError(503, "White-label CNAME target is not configured.");
  if (input.kind === "api" && !input.account.entitlements!.customApiDomains) {
    throw new HttpError(403, "This account does not include custom API domains.");
  }
  if (input.kind !== "api" && !input.account.entitlements!.customDomains) {
    throw new HttpError(403, "This account does not include custom domains.");
  }
  const brand = await WhiteLabelBrandModel.findOne({ _id: input.brandId, accountId: input.account.id });
  if (!brand) throw new HttpError(404, "Brand not found.");
  const hostname = normalizeHostname(input.hostname);
  if (isPlatformHostname(hostname) || hostname === env.whiteLabelCnameTarget) {
    throw new HttpError(409, "This hostname is reserved for the direct platform and cannot be assigned to a white-label brand.");
  }
  const token = randomBytes(24).toString("base64url");
  const ownershipName = `_wl-verification.${hostname}`;
  let domain;
  try {
    domain = await WhiteLabelDomainModel.create({
      accountId: input.account._id,
      brandId: brand._id,
      hostname,
      kind: input.kind,
      verificationToken: token,
      requiredRecords: [
        { type: "TXT", name: ownershipName, value: token, purpose: "ownership" },
        { type: "CNAME", name: hostname, value: env.whiteLabelCnameTarget, purpose: "routing" },
      ],
      status: "pending",
      nextCheckAt: new Date(),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new HttpError(409, "This hostname is already reserved.");
    }
    throw error;
  }

  try {
    const provisioned = await cloudflareRequest(
      `/zones/${encodeURIComponent(env.cloudflareZoneId)}/custom_hostnames`,
      {
        method: "POST",
        body: JSON.stringify({
          hostname,
          ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
          custom_metadata: { white_label_domain_id: domain.id, account_id: input.account.id },
        }),
      },
    );
    domain.set("edge.provider", "cloudflare");
    domain.set("edge.providerHostnameId", provisioned.id ?? "");
    domain.set("edge.hostnameStatus", provisioned.status ?? "pending");
    domain.set("edge.lastSyncedAt", new Date());
    domain.set("tls.status", provisioned.ssl?.status ?? "pending_validation");
    domain.requiredRecords.push(...providerValidationRecords(provisioned));
    domain.status = "awaiting_dns";
    await domain.save();
  } catch (error) {
    domain.status = "failed";
    domain.failureReason = error instanceof Error ? error.message.slice(0, 1_000) : "Edge provisioning failed.";
    domain.nextCheckAt = new Date(Date.now() + 5 * 60_000);
    await domain.save();
    throw error;
  }
  invalidateHostnameCache(hostname);
  return WhiteLabelDomainModel.findById(domain._id).select("+verificationToken +edge.providerHostnameId");
}

async function txtRecordContains(name: string, expected: string) {
  try {
    const rows = await resolveTxt(name);
    return rows.some((segments) => segments.join("") === expected);
  } catch {
    return false;
  }
}

async function cnamePointsTo(hostname: string, expected: string) {
  try {
    const values = await resolveCname(hostname);
    return values.some((value) => cleanDnsValue(value) === cleanDnsValue(expected));
  } catch {
    return false;
  }
}

export async function verifyWhiteLabelDomain(accountId: string, domainId: string) {
  const domain = await WhiteLabelDomainModel.findOne({ _id: domainId, accountId })
    .select("+verificationToken +edge.providerHostnameId");
  if (!domain) throw new HttpError(404, "Domain not found.");
  if (domain.status === "disabled") throw new HttpError(409, "Disabled domains cannot be verified.");
  if (domain.status !== "active") domain.status = "verifying";
  domain.lastCheckedAt = new Date();
  await domain.save();

  if (domain.edge!.provider !== "cloudflare" || !domain.edge!.providerHostnameId) {
    const provisioned = await cloudflareRequest(
      `/zones/${encodeURIComponent(env.cloudflareZoneId)}/custom_hostnames`,
      {
        method: "POST",
        body: JSON.stringify({
          hostname: domain.hostname,
          ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
          custom_metadata: { white_label_domain_id: domain.id, account_id: accountId },
        }),
      },
    );
    domain.set("edge.provider", "cloudflare");
    domain.set("edge.providerHostnameId", provisioned.id ?? "");
    domain.set("edge.hostnameStatus", provisioned.status ?? "pending");
    domain.set("edge.lastSyncedAt", new Date());
    domain.set("tls.status", provisioned.ssl?.status ?? "pending_validation");
    const baseRecords = domain.requiredRecords.filter((record) => record.purpose !== "certificate");
    domain.requiredRecords = [...baseRecords, ...providerValidationRecords(provisioned)] as typeof domain.requiredRecords;
    await domain.save();
  }

  const ownershipRecord = domain.requiredRecords.find((record) => record.purpose === "ownership" && record.type === "TXT");
  const [ownershipVerified, routingVerified] = await Promise.all([
    txtRecordContains(ownershipRecord?.name || `_vozon-verification.${domain.hostname}`, domain.verificationToken),
    cnamePointsTo(domain.hostname, env.whiteLabelCnameTarget),
  ]);
  if (ownershipVerified && !domain.ownershipVerifiedAt) domain.ownershipVerifiedAt = new Date();
  if (routingVerified && !domain.routingVerifiedAt) domain.routingVerifiedAt = new Date();

  let provider: CloudflareCustomHostname | null = null;
  if (domain.edge!.provider === "cloudflare" && domain.edge!.providerHostnameId) {
    try {
      provider = await cloudflareRequest(
        `/zones/${encodeURIComponent(env.cloudflareZoneId)}/custom_hostnames/${encodeURIComponent(domain.edge!.providerHostnameId)}`,
      );
      domain.set("edge.hostnameStatus", provider.status ?? "");
      domain.set("edge.lastSyncedAt", new Date());
      domain.set("tls.status", provider.ssl?.status ?? "pending_validation");
      domain.set("tls.issuer", provider.ssl?.issuer ?? "");
      if (provider.ssl?.expires_on) domain.set("tls.expiresAt", new Date(provider.ssl.expires_on));
      const baseRecords = domain.requiredRecords.filter((record) => record.purpose !== "certificate");
      domain.requiredRecords = [...baseRecords, ...providerValidationRecords(provider)] as typeof domain.requiredRecords;
    } catch (error) {
      domain.failureReason = error instanceof Error ? error.message.slice(0, 1_000) : "Edge status check failed.";
    }
  }

  const edgeReady = provider?.status === "active";
  const tlsReady = provider?.ssl?.status === "active";
  if (!ownershipVerified || !routingVerified) {
    domain.status = "awaiting_dns";
  } else if (!edgeReady || !tlsReady) {
    domain.status = "awaiting_certificate";
  } else {
    domain.status = "active";
    domain.failureReason = "";
    domain.activatedAt = domain.activatedAt ?? new Date();
  }
  domain.nextCheckAt = new Date(Date.now() + (domain.status === "active" ? 6 * 60 * 60_000 : 5 * 60_000));
  await domain.save();
  invalidateHostnameCache(domain.hostname);
  return WhiteLabelDomainModel.findById(domain._id).select("+verificationToken");
}

export async function processDueWhiteLabelDomains(limit = 20) {
  if (!env.whiteLabelEnabled) return 0;
  let processed = 0;
  for (let index = 0; index < Math.min(100, Math.max(1, limit)); index += 1) {
    const claimed = await WhiteLabelDomainModel.findOneAndUpdate(
      {
        status: { $nin: ["disabled"] },
        nextCheckAt: { $lte: new Date() },
      },
      { $set: { nextCheckAt: new Date(Date.now() + 2 * 60_000) } },
      { new: true, sort: { nextCheckAt: 1 } },
    ).select("accountId");
    if (!claimed) break;
    try {
      await verifyWhiteLabelDomain(String(claimed.accountId), claimed.id);
    } catch (error) {
      await WhiteLabelDomainModel.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: "failed",
            failureReason: error instanceof Error ? error.message.slice(0, 1_000) : "Automated domain verification failed.",
            nextCheckAt: new Date(Date.now() + 5 * 60_000),
          },
        },
      );
    }
    processed += 1;
  }
  return processed;
}

export async function processDueWhiteLabelSubscriptions(limit = 100) {
  if (!env.whiteLabelEnabled) return 0;
  const now = new Date();
  const retailBilledAccountIds = await WhiteLabelAccountModel.distinct("_id", { "retailBilling.enabled": true });
  const due = await WhiteLabelSubscriptionModel.find({
    ...(retailBilledAccountIds.length ? { accountId: { $nin: retailBilledAccountIds } } : {}),
    status: { $in: ["trialing", "active"] },
    currentPeriodEnd: { $lte: now },
  }).select("_id accountId orgId status currentPeriodEnd").limit(Math.min(500, Math.max(1, limit))).lean();
  if (!due.length) return 0;
  let processed = 0;
  for (const subscription of due) {
    const updated = await WhiteLabelSubscriptionModel.findOneAndUpdate(
      {
        _id: subscription._id,
        status: { $in: ["trialing", "active"] },
        currentPeriodEnd: { $lte: now },
      },
      { $set: { status: "past_due" } },
      { new: true },
    );
    if (!updated) continue;
    await PlatformAuditLogModel.create({
      actorType: "system",
      actorEmail: "system@internal",
      action: "white_label.subscription_past_due",
      resource: "white_label_subscription",
      resourceId: updated.id,
      accountId: updated.accountId,
      targetOrgId: updated.orgId,
      reason: "Subscription period ended without a recorded renewal.",
      before: { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
      after: { status: updated.status },
    });
    processed += 1;
  }
  return processed;
}

export function invalidateHostnameCache(hostname?: string) {
  if (hostname) hostnameCache.delete(hostname);
  else hostnameCache.clear();
}

function defaultBrand(hostname: string): PublicBrandConfig {
  return {
    source: "platform",
    hostname,
    productName: "Vozon",
    companyName: "Vozon",
    logoUrl: "/images/logo_2.svg",
    logoDarkUrl: "/images/logo_2.svg",
    iconUrl: "/icons/vozon-mark-192.png",
    urls: {
      app: env.clientUrl.replace(/\/$/, ""),
      api: env.backendPublicUrl,
      links: env.backendPublicUrl,
    },
    colors: {
      primary: "#45ddce",
      secondary: "#071b18",
      accent: "#75fff0",
      surface: "#020807",
    },
    defaultTheme: "dark",
    support: {
      email: env.supportInbox,
      phone: "",
      websiteUrl: env.clientUrl,
      helpCenterUrl: `${env.clientUrl}/docs`,
      statusPageUrl: "",
    },
    legal: {
      termsUrl: `${env.clientUrl}/terms`,
      privacyUrl: `${env.clientUrl}/privacy`,
      cookiePolicyUrl: "",
      legalBusinessName: "Vozon",
      businessAddress: "",
    },
    poweredBy: { visible: false, text: "" },
    authentication: { registrationMode: "open", googleSignIn: Boolean(env.googleClientId) },
  };
}

function brandPublicConfig(
  hostname: string,
  account: HydratedDocument<WhiteLabelAccount>,
  brand: HydratedDocument<WhiteLabelBrand>,
  domains: Array<{ kind: "app" | "api" | "link"; hostname: string }>,
): PublicBrandConfig {
  const branding = brand.branding!;
  const hostnameFor = (kind: "app" | "api" | "link") =>
    domains.find((domain) => domain.kind === kind)?.hostname ?? "";
  const appHostname = hostnameFor("app") || hostname;
  const apiHostname = hostnameFor("api");
  const linkHostname = hostnameFor("link");
  return {
    source: "white_label",
    hostname,
    productName: branding.productName,
    companyName: branding.companyName,
    logoUrl: branding.logoUrl,
    logoDarkUrl: branding.logoDarkUrl || branding.logoUrl,
    iconUrl: branding.iconUrl,
    urls: {
      app: `https://${appHostname}`,
      api: apiHostname ? `https://${apiHostname}` : env.backendPublicUrl,
      links: linkHostname
        ? `https://${linkHostname}`
        : apiHostname
          ? `https://${apiHostname}`
          : env.backendPublicUrl,
    },
    colors: {
      primary: branding.primaryColor,
      secondary: branding.secondaryColor,
      accent: branding.accentColor,
      surface: branding.surfaceColor,
    },
    defaultTheme: branding.defaultTheme,
    support: compact(brand.support),
    legal: compact(brand.legal),
    poweredBy: {
      visible: !account.entitlements!.removePoweredBy,
      text: branding.poweredByText || "Powered by Vozon",
    },
    authentication: {
      registrationMode: account.customerOnboarding?.registrationMode ?? "invite_only",
      googleSignIn: Boolean(account.customerOnboarding?.allowGoogleSignIn && env.googleClientId),
    },
  };
}

function browserOrigin(request: Request) {
  const value = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (env.nodeEnv === "production" && url.protocol !== "https:") return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { hostname: normalizeHostname(url.hostname), origin: url.origin };
  } catch {
    return null;
  }
}

function requestHostOrigin(request: Request) {
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
    ? request.headers["x-forwarded-host"].split(",", 1)[0]?.trim()
    : "";
  const host = forwardedHost || String(request.headers.host ?? "").trim();
  if (!host) return null;
  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"].split(",", 1)[0]?.trim().toLowerCase()
    : "";
  const protocol = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : env.nodeEnv === "production" ? "https" : request.protocol;
  if (env.nodeEnv === "production" && protocol !== "https") return null;
  try {
    const url = new URL(`${protocol}://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { hostname: normalizeHostname(url.hostname), origin: url.origin };
  } catch {
    return null;
  }
}

export async function resolveWhiteLabelRequestContext(request: Request): Promise<WhiteLabelRequestContext | null> {
  if (!env.whiteLabelEnabled) return null;
  const source = browserOrigin(request) ?? requestHostOrigin(request);
  if (!source) return null;
  if (isPlatformHostname(source.hostname)) return null;
  const domain = await WhiteLabelDomainModel.findOne({
    hostname: source.hostname,
    status: "active",
    kind: { $in: ["app", "api", "link"] },
  });
  if (!domain) return null;
  const [account, brand, relatedDomains] = await Promise.all([
    WhiteLabelAccountModel.findOne({
      _id: domain.accountId,
      status: "active",
      billingStatus: { $in: ["trialing", "active"] },
    }),
    WhiteLabelBrandModel.findOne({
      _id: domain.brandId,
      accountId: domain.accountId,
      status: "published",
    }),
    WhiteLabelDomainModel.find({
      accountId: domain.accountId,
      brandId: domain.brandId,
      status: "active",
      kind: { $in: ["app", "api", "link"] },
    }).select("kind hostname").lean(),
  ]);
  if (!account || !brand) return null;
  const appDomain = relatedDomains.find((item) => item.kind === "app");
  const apiDomain = relatedDomains.find((item) => item.kind === "api");
  const linkDomain = relatedDomains.find((item) => item.kind === "link");
  const appOrigin = appDomain
    ? `https://${appDomain.hostname}`
    : domain.kind === "app"
      ? source.origin
      : env.clientUrl.replace(/\/$/, "");
  const apiOrigin = apiDomain
    ? `https://${apiDomain.hostname}`
    : domain.kind === "api"
      ? source.origin
      : env.backendPublicUrl;
  return {
    accountId: account.id,
    brandId: brand.id,
    productName: brand.branding!.productName,
    hostname: source.hostname,
    origin: appOrigin,
    apiOrigin,
    linkOrigin: linkDomain ? `https://${linkDomain.hostname}` : apiOrigin,
    registrationMode: account.customerOnboarding?.registrationMode ?? "invite_only",
    allowGoogleSignIn: Boolean(account.customerOnboarding?.allowGoogleSignIn),
    requireEmailVerification: account.customerOnboarding?.requireEmailVerification ?? true,
  };
}

export async function trustedClientBaseUrl(request: Request) {
  return (await resolveWhiteLabelRequestContext(request))?.origin ?? env.clientUrl;
}

export function emailBrandFromDocument(brand: HydratedDocument<WhiteLabelBrand>): EmailBrand {
  return {
    productName: brand.branding!.productName,
    companyName: brand.branding!.companyName,
    primaryColor: brand.branding!.primaryColor,
    secondaryColor: brand.branding!.secondaryColor,
    accentColor: brand.branding!.accentColor,
    logoUrl: brand.branding!.logoUrl || undefined,
    supportEmail: brand.support!.email || undefined,
    supportUrl: brand.support!.helpCenterUrl || brand.support!.websiteUrl || undefined,
    legalBusinessName: brand.legal!.legalBusinessName || brand.branding!.companyName,
    fromAddress: brand.email!.sendingDomainStatus === "verified" ? brand.email!.fromAddress || undefined : undefined,
    replyTo: brand.email!.replyTo || brand.support!.email || undefined,
  };
}

export async function emailBrandForRequest(request: Request) {
  const context = await resolveWhiteLabelRequestContext(request);
  if (!context) return undefined;
  const brand = await WhiteLabelBrandModel.findOne({
    _id: context.brandId,
    accountId: context.accountId,
    status: "published",
  });
  return brand ? emailBrandFromDocument(brand) : undefined;
}

export async function resolvePublicBrand(value: string, platformFallback = true) {
  let hostname: string;
  try {
    hostname = normalizeHostname(value);
  } catch {
    hostname = safeHostnameFromUrl(env.clientUrl) || "localhost";
    return platformFallback ? defaultBrand(hostname) : null;
  }
  if (isPlatformHostname(hostname)) return platformFallback ? defaultBrand(hostname) : null;
  if (!env.whiteLabelEnabled) return platformFallback ? defaultBrand(hostname) : null;
  const cached = hostnameCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.value ?? (platformFallback ? defaultBrand(hostname) : null);

  const domain = await WhiteLabelDomainModel.findOne({ hostname, kind: "app", status: "active" });
  let valueToCache: PublicBrandConfig | null = null;
  if (domain) {
    const [account, brand, domains] = await Promise.all([
      WhiteLabelAccountModel.findOne({ _id: domain.accountId, status: "active", billingStatus: { $in: ["trialing", "active"] } }),
      WhiteLabelBrandModel.findOne({ _id: domain.brandId, accountId: domain.accountId, status: "published" }),
      WhiteLabelDomainModel.find({
        accountId: domain.accountId,
        brandId: domain.brandId,
        status: "active",
      }).select("kind hostname").lean(),
    ]);
    if (account && brand) valueToCache = brandPublicConfig(hostname, account, brand, domains);
  }
  hostnameCache.set(hostname, { expiresAt: Date.now() + HOSTNAME_CACHE_TTL_MS, value: valueToCache });
  return valueToCache ?? (platformFallback ? defaultBrand(hostname) : null);
}

export async function isAllowedWhiteLabelOrigin(origin: string) {
  if (!env.whiteLabelEnabled) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  if (env.nodeEnv === "production" && url.protocol !== "https:") return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
    return false;
  }
  return Boolean(await resolvePublicBrand(url.hostname, false));
}

export async function productNameForOrganization(orgId: string, fallback = "Vozon") {
  if (!env.whiteLabelEnabled) return fallback;
  const organization = await OrganizationModel.findById(orgId)
    .select("whiteLabelAccountId whiteLabelBrandId")
    .lean();
  if (!organization?.whiteLabelAccountId || !organization.whiteLabelBrandId) return fallback;
  const brand = await WhiteLabelBrandModel.findOne({
    _id: organization.whiteLabelBrandId,
    accountId: organization.whiteLabelAccountId,
    status: "published",
  }).select("branding.productName").lean();
  return brand?.branding?.productName?.trim() || fallback;
}

export async function assertCustomerBelongsToAccount(accountId: string, orgId: string) {
  const organization = await OrganizationModel.findOne({
    _id: orgId,
    whiteLabelAccountId: accountId,
  });
  if (!organization) throw new HttpError(404, "Customer organization not found.");
  return organization;
}
