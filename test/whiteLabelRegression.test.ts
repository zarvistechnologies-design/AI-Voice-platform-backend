import assert from "node:assert/strict";
import test from "node:test";

import { assertCallCapacity, calculateWhiteLabelUsageCharge, ensureCreditWallet, recentCreditTransactions } from "../src/services/billingService.js";
import { BillingTransactionModel } from "../src/models/BillingTransaction.js";
import { CreditWalletModel } from "../src/models/CreditWallet.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { customerActivationEmail } from "../src/services/emailTemplates.js";
import { normalizeHostname, resolvePublicBrand, resolveWhiteLabelRequestContext } from "../src/services/whiteLabelService.js";
import { validateBrandAssetUrl } from "../src/services/whiteLabelService.js";
import { organizationMatchesRequestDomain } from "../src/middleware/auth.js";
import {
  assertAgentModelsAllowed,
  assertWhiteLabelModelAccessSubset,
  filterModelCatalogForAccess,
} from "../src/services/whiteLabelModelAccessService.js";
import {
  calculateWhiteLabelPartnerInvoice,
  whiteLabelContractPeriod,
} from "../src/services/whiteLabelPartnerBillingService.js";
import {
  assertWhiteLabelCustomerPaymentMatches,
  calculateWhiteLabelCustomerInvoice,
  calculateWhiteLabelCustomerRefundTotal,
  type WhiteLabelCustomerRazorpayOrder,
  type WhiteLabelCustomerRazorpayPayment,
} from "../src/services/whiteLabelCustomerBillingService.js";
import { WhiteLabelCustomerInvoiceModel } from "../src/models/WhiteLabelCustomerInvoice.js";
import { WhiteLabelAccountModel } from "../src/models/WhiteLabelAccount.js";
import { WhiteLabelDomainModel } from "../src/models/WhiteLabelDomain.js";
import { WhiteLabelBrandModel } from "../src/models/WhiteLabelBrand.js";
import { readWhiteLabelResendKey, storeWhiteLabelResendKey } from "../src/services/whiteLabelResendKey.js";
import { redactedAuditSnapshot } from "../src/services/auditLogService.js";
import { WhiteLabelSubscriptionModel } from "../src/models/WhiteLabelSubscription.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { env } from "../src/config/env.js";
import { isPlatformHostname } from "../src/services/whiteLabelService.js";
import { requireWhiteLabelEnabled } from "../src/middleware/whiteLabelEnabled.js";
import { assertWhiteLabelPublicCallCapacity, requireWhiteLabelCallCapacity } from "../src/middleware/whiteLabelEntitlements.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { resetPassword } from "../src/controllers/authController.js";
import { provisionPartnerCustomer, resendPartnerCustomerActivation } from "../src/controllers/partnerWhiteLabelController.js";
import { completeInvitation, previewInvitation } from "../src/controllers/organizationController.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationInvitationModel } from "../src/models/OrganizationInvitation.js";
import { UserModel } from "../src/models/User.js";
import { WhiteLabelPlanModel } from "../src/models/WhiteLabelPlan.js";
import { AuditLogModel } from "../src/models/AuditLog.js";

const brand = {
  productName: "Acme Voice",
  companyName: "Acme Services",
  primaryColor: "#ffcc00",
  secondaryColor: "#111827",
  accentColor: "#a855f7",
  legalBusinessName: "Acme Services Private Limited",
};

test("customer billing includes call deductions without exposing partner costs", async (context) => {
  let filter: Record<string, unknown> = {};
  let fields = "";
  const query = {
    select(value: string) { fields = value; return this; },
    sort() { return this; },
    limit() { return Promise.resolve([]); },
  };
  context.mock.method(BillingTransactionModel, "find", (value: Record<string, unknown>) => {
    filter = value;
    return query as never;
  });

  await recentCreditTransactions("customer-org", 50, true);
  assert.deepEqual(filter, { orgId: "customer-org" });
  assert.match(fields, /amountCredits/);
  assert.match(fields, /callId/);
  assert.doesNotMatch(fields, /breakdown|metadata|wholesale|partnerMargin/);

  await recentCreditTransactions("direct-org", 25);
  assert.deepEqual(filter, { orgId: "direct-org", category: { $ne: "call" } });
});

test("included white-label minutes admit calls with a zero wallet until exhausted", async (context) => {
  const previous = env.whiteLabelEnabled;
  env.whiteLabelEnabled = true;
  let usedSeconds = 60 * 60;
  const subscription = {
    status: "active",
    priceSnapshot: { currency: "USD" },
    allowancesSnapshot: { includedMinutes: 100 },
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: new Date("2099-12-01T00:00:00Z"),
  };
  context.mock.method(OrganizationModel, "findById", () => ({ select: () => ({ lean: async () => ({ whiteLabelAccountId: "partner" }) }) }) as never);
  context.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({ select: () => ({ lean: async () => subscription }) }) as never);
  context.mock.method(CreditWalletModel, "findOneAndUpdate", async () => ({ balanceCredits: 0, currency: "USD" }) as never);
  context.mock.method(CallDetailRecordModel, "aggregate", async () => [{ seconds: usedSeconds }] as never);
  try {
    await assert.doesNotReject(() => assertCallCapacity("customer-org"));
    usedSeconds = 100 * 60;
    await assert.rejects(() => assertCallCapacity("customer-org"), /Insufficient credits/);
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("white-label wallet rejects a subscription currency mismatch before billing", async (context) => {
  const previous = env.whiteLabelEnabled;
  env.whiteLabelEnabled = true;
  context.mock.method(OrganizationModel, "findById", () => ({ select: () => ({ lean: async () => ({ whiteLabelAccountId: "partner" }) }) }) as never);
  context.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({ select: () => ({ lean: async () => ({ priceSnapshot: { currency: "INR" } }) }) }) as never);
  context.mock.method(CreditWalletModel, "findOneAndUpdate", async () => ({ balanceCredits: 10, currency: "USD" }) as never);
  try {
    await assert.rejects(() => ensureCreditWallet("customer-org"), /wallet is USD, but the subscription is INR/);
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("white-label wallet does not default a missing subscription currency to USD", async (context) => {
  const previous = env.whiteLabelEnabled;
  env.whiteLabelEnabled = true;
  context.mock.method(OrganizationModel, "findById", () => ({ select: () => ({ lean: async () => ({ whiteLabelAccountId: "partner" }) }) }) as never);
  context.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({ select: () => ({ lean: async () => ({ priceSnapshot: {} }) }) }) as never);
  try {
    await assert.rejects(() => ensureCreditWallet("customer-org"), /no valid billing currency/);
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("white-label management fails closed when its rollout switch is disabled", () => {
  const original = env.whiteLabelEnabled;
  try {
    env.whiteLabelEnabled = false;
    let disabledError: unknown;
    requireWhiteLabelEnabled({} as never, {} as never, (error?: unknown) => {
      disabledError = error;
    });
    assert.equal((disabledError as { statusCode?: number })?.statusCode, 404);

    env.whiteLabelEnabled = true;
    let enabledError: unknown = "not-called";
    requireWhiteLabelEnabled({} as never, {} as never, (error?: unknown) => {
      enabledError = error;
    });
    assert.equal(enabledError, undefined);
  } finally {
    env.whiteLabelEnabled = original;
  }
});

test("white-label hostnames reject origins, ports, credentials, IPs, and localhost", () => {
  assert.equal(normalizeHostname("App.Example.com."), "app.example.com");
  for (const invalid of [
    "https://app.example.com",
    "app.example.com:443",
    "user@app.example.com",
    "127.0.0.1",
    "localhost",
    "bad label.example.com",
  ]) {
    assert.throws(() => normalizeHostname(invalid));
  }
});

test("only the exact active app hostname resolves as a public brand or request context", async (context) => {
  const previous = env.whiteLabelEnabled;
  const queries: Array<Record<string, unknown>> = [];
  context.mock.method(WhiteLabelDomainModel, "findOne", (query: Record<string, unknown>) => {
    queries.push(query);
    return Promise.resolve(null) as never;
  });
  try {
    env.whiteLabelEnabled = true;
    assert.equal(await resolvePublicBrand("reserved.example", false), null);
    assert.equal(await resolveWhiteLabelRequestContext({ headers: { origin: "https://reserved.example" } } as never), null);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries.map((query) => [query.hostname, query.status]), [
      ["reserved.example", "active"],
      ["reserved.example", "active"],
    ]);
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("white-label Resend keys are encrypted for new writes and omitted from brand JSON", () => {
  const key = "re_example_secret";
  const stored = storeWhiteLabelResendKey(key);
  assert.notEqual(stored, key);
  assert.equal(readWhiteLabelResendKey(stored), key);
  assert.equal(readWhiteLabelResendKey(key), key); // Existing records remain usable until migration.
  const brand = new WhiteLabelBrandModel({ email: { resendApiKey: stored } });
  const serialized = JSON.stringify(brand);
  assert.doesNotMatch(serialized, /re_example_secret|enc:v1:/);
  assert.match(serialized, /"hasResendApiKey":true/);
});

test("audit snapshots redact branded email and payment credentials", () => {
  const snapshot = redactedAuditSnapshot({
    email: { resendApiKey: "re_secret" },
    retailBilling: { customKeySecretEncrypted: "ciphertext" },
    brands: [{ email: { resendApiKey: "re_other" } }],
  }) as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(snapshot), /re_secret|re_other|ciphertext/);
  assert.match(JSON.stringify(snapshot), /\[REDACTED\]/);
});

test("organization access is bound to the exact platform or account-and-brand domain", () => {
  const brandedOrganization = { whiteLabelAccountId: "account-a", whiteLabelBrandId: "brand-a" };
  const context = {
    accountId: "account-a",
    brandId: "brand-a",
    productName: "Acme Voice",
    hostname: "app.acme.example",
    origin: "https://app.acme.example",
    apiOrigin: "https://api.acme.example",
    linkOrigin: "https://links.acme.example",
    registrationMode: "invite_only" as const,
    allowGoogleSignIn: false,
    requireEmailVerification: true,
  };
  assert.equal(organizationMatchesRequestDomain(brandedOrganization, context), true);
  assert.equal(organizationMatchesRequestDomain(brandedOrganization, { ...context, brandId: "brand-b" }), false);
  assert.equal(organizationMatchesRequestDomain(brandedOrganization, null), false);
  assert.equal(organizationMatchesRequestDomain({}, null), true);
  assert.equal(organizationMatchesRequestDomain({}, context), false);
});

test("direct organizations and white-label partner owners remain on the normal platform", () => {
  assert.equal(organizationMatchesRequestDomain({}, null), true);
  const partnerOwnerOrganization = { whiteLabelOwnerAccountId: "account-a" };
  assert.equal(organizationMatchesRequestDomain(partnerOwnerOrganization, null), true);
  assert.equal(organizationMatchesRequestDomain({ whiteLabelAccountId: "account-a" }, null), false);
  assert.equal(organizationMatchesRequestDomain({ whiteLabelBrandId: "brand-a" }, null), true);
});

test("configured direct-platform hosts cannot be classified as white-label hosts", () => {
  assert.equal(isPlatformHostname("localhost"), true);
  assert.equal(isPlatformHostname("127.0.0.1"), true);
  assert.equal(isPlatformHostname(new URL(env.clientUrl).hostname), true);
  assert.equal(isPlatformHostname("customer-brand.example"), false);
});

test("white-label brand assets require public HTTPS image URLs", () => {
  assert.equal(
    validateBrandAssetUrl("https://cdn.example.com/brand/logo.svg", "Logo URL"),
    "https://cdn.example.com/brand/logo.svg",
  );
  for (const invalid of [
    "http://cdn.example.com/logo.png",
    "https://127.0.0.1/logo.png",
    "https://assets.local/logo.png",
    "https://cdn.example.com/logo.html",
  ]) {
    assert.throws(() => validateBrandAssetUrl(invalid, "Logo URL"));
  }
});

test("branded activation email contains no platform-brand leakage", () => {
  const email = customerActivationEmail({
    brand,
    organizationName: "Acme North",
    recipientName: "Alex",
    activationUrl: "https://app.acme.example/reset-password?token=secret",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  assert.match(email.subject, /Acme Voice/);
  assert.match(email.html, /Acme Services Private Limited/);
  assert.match(email.html, /#ffcc00/);
  assert.doesNotMatch(email.subject + email.text + email.html, /Vozon/i);
});

test("cost-markup pricing preserves the wholesale, customer, FX, and signed margin snapshots", () => {
  const charge = calculateWhiteLabelUsageCharge({
    providerCostUsd: 1,
    platformFeeUsd: 0.2,
    durationSeconds: 60,
    currency: "USD",
    inrPerUsd: 96.5,
    usagePricing: { mode: "cost_markup", markupBps: 2500 },
  });
  assert.equal(charge.wholesaleCost, 1.2);
  assert.equal(charge.targetCharge, 1.5);
  assert.equal(charge.partnerMargin, 0.3);
  assert.equal(charge.fxRate, 1);

  const inr = calculateWhiteLabelUsageCharge({
    providerCostUsd: 1,
    platformFeeUsd: 0,
    durationSeconds: 60,
    currency: "INR",
    inrPerUsd: 96.5,
    usagePricing: { mode: "cost_markup", markupBps: 1000 },
  });
  assert.equal(inr.wholesaleCost, 96.5);
  assert.equal(inr.targetCharge, 106.15);
  assert.equal(inr.partnerMargin, 9.65);
});

test("included minutes and included-only plans do not silently bill the customer", () => {
  const partiallyIncluded = calculateWhiteLabelUsageCharge({
    providerCostUsd: 1,
    platformFeeUsd: 0.2,
    durationSeconds: 60,
    currency: "USD",
    inrPerUsd: 96.5,
    includedSecondsRemaining: 30,
    usagePricing: { mode: "cost_markup", markupBps: 2500 },
  });
  assert.equal(partiallyIncluded.targetCharge, 0.75);
  assert.equal(partiallyIncluded.partnerMargin, -0.45);

  const includedOnly = calculateWhiteLabelUsageCharge({
    providerCostUsd: 2,
    platformFeeUsd: 0.5,
    durationSeconds: 300,
    currency: "USD",
    inrPerUsd: 96.5,
    usagePricing: { mode: "included_only", overageEnabled: false },
  });
  assert.equal(includedOnly.targetCharge, 0);
  assert.equal(includedOnly.wholesaleCost, 2.5);
  assert.equal(includedOnly.partnerMargin, -2.5);
});

test("fixed per-minute pricing prorates seconds and applies a minimum only to billable usage", () => {
  const included = calculateWhiteLabelUsageCharge({
    providerCostUsd: 0.1,
    platformFeeUsd: 0,
    durationSeconds: 30,
    currency: "USD",
    inrPerUsd: 96.5,
    includedSecondsRemaining: 30,
    usagePricing: { mode: "fixed_per_minute", perMinuteAmountMinor: 50, minimumCallAmountMinor: 25 },
  });
  assert.equal(included.targetCharge, 0);

  const billable = calculateWhiteLabelUsageCharge({
    providerCostUsd: 0.1,
    platformFeeUsd: 0,
    durationSeconds: 30,
    currency: "USD",
    inrPerUsd: 96.5,
    usagePricing: { mode: "fixed_per_minute", perMinuteAmountMinor: 50, minimumCallAmountMinor: 30 },
  });
  assert.equal(billable.targetCharge, 0.3);
});

test("white-label plans cannot grant models outside the super-admin ceiling", () => {
  const ceiling = {
    stt: ["openai:gpt-4o-mini-transcribe"],
    llm: ["openai:gpt-4.1-mini"],
    tts: ["openai:gpt-4o-mini-tts"],
  };
  assert.doesNotThrow(() => assertWhiteLabelModelAccessSubset(ceiling, ceiling));
  assert.throws(() => assertWhiteLabelModelAccessSubset({
    ...ceiling,
    llm: ["openai:gpt-4.1"],
  }, ceiling), /not allowed by the platform contract/i);
});

test("realtime models are enforced under LLM access and pipeline stacks enforce all three categories", () => {
  const access = {
    stt: ["openai:gpt-4o-mini-transcribe"],
    llm: ["openai:gpt-realtime-2.1", "openai:gpt-4.1-mini"],
    tts: ["openai:gpt-4o-mini-tts"],
  };
  assert.doesNotThrow(() => assertAgentModelsAllowed(access, {
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: "gpt-realtime-2.1",
  }));
  assert.doesNotThrow(() => assertAgentModelsAllowed(access, {
    pipelineMode: "pipeline",
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
  }));
  assert.throws(() => assertAgentModelsAllowed(access, {
    pipelineMode: "pipeline",
    sttProvider: "openai",
    sttModel: "whisper-1",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
  }), /not included in this customer plan/i);
});

test("customer model catalogs hide models outside the subscription snapshot", () => {
  const catalog = {
    realtime: [{ provider: "openai", models: ["gpt-realtime-2.1", "premium-realtime"] }],
    llm: [{ provider: "openai", models: ["gpt-4.1-mini", "gpt-4.1"] }],
    stt: [{ provider: "openai", models: ["gpt-4o-mini-transcribe", "whisper-1"] }],
    tts: [{ provider: "openai", models: ["gpt-4o-mini-tts", "tts-1-hd"] }],
  };
  const filtered = filterModelCatalogForAccess(catalog, {
    stt: ["openai:gpt-4o-mini-transcribe"],
    llm: ["openai:gpt-realtime-2.1", "openai:gpt-4.1-mini"],
    tts: ["openai:gpt-4o-mini-tts"],
  });
  assert.deepEqual(filtered.realtime[0]?.models, ["gpt-realtime-2.1"]);
  assert.deepEqual(filtered.llm[0]?.models, ["gpt-4.1-mini"]);
  assert.deepEqual(filtered.stt[0]?.models, ["gpt-4o-mini-transcribe"]);
  assert.deepEqual(filtered.tts[0]?.models, ["gpt-4o-mini-tts"]);
});

test("partner invoice applies included credits, wholesale markup, and minimum commitment once", () => {
  const usageAboveMinimum = calculateWhiteLabelPartnerInvoice({
    platformFeeMinor: 49_900,
    minimumCommitmentMinor: 10_000,
    usageWholesaleMinor: 20_000,
    includedCreditMinor: 5_000,
    wholesaleMarkupBps: 1_000,
  });
  assert.deepEqual(usageAboveMinimum, {
    platformFeeMinor: 49_900,
    minimumCommitmentMinor: 10_000,
    usageWholesaleMinor: 20_000,
    includedCreditDiscountMinor: 5_000,
    usageMarkupMinor: 1_500,
    committedUsageMinor: 16_500,
    subtotalMinor: 66_400,
    taxRateBps: 1_800,
    taxLabel: "GST",
    taxMinor: 11_952,
    totalMinor: 78_352,
  });

  const minimumWins = calculateWhiteLabelPartnerInvoice({
    platformFeeMinor: 49_900,
    minimumCommitmentMinor: 10_000,
    usageWholesaleMinor: 2_000,
    includedCreditMinor: 500,
    wholesaleMarkupBps: 1_000,
  });
  assert.equal(minimumWins.committedUsageMinor, 10_000);
  assert.equal(minimumWins.subtotalMinor, 59_900);
  assert.equal(minimumWins.taxMinor, 10_782);
  assert.equal(minimumWins.totalMinor, 70_682);
});

test("partner contract periods use stable UTC month or year boundaries", () => {
  const at = new Date("2030-07-19T13:45:00.000Z");
  assert.deepEqual(whiteLabelContractPeriod(at, "month"), {
    periodStart: new Date("2030-07-01T00:00:00.000Z"),
    periodEnd: new Date("2030-08-01T00:00:00.000Z"),
  });
  assert.deepEqual(whiteLabelContractPeriod(at, "year"), {
    periodStart: new Date("2030-01-01T00:00:00.000Z"),
    periodEnd: new Date("2031-01-01T00:00:00.000Z"),
  });
});

test("customer invoices snapshot exclusive and inclusive tax without changing the quoted total", () => {
  assert.deepEqual(calculateWhiteLabelCustomerInvoice({
    recurringAmountMinor: 10_000,
    setupFeeMinor: 2_000,
    taxBehavior: "exclusive",
    taxRateBps: 1_800,
  }), {
    recurringAmountMinor: 10_000,
    setupFeeMinor: 2_000,
    subtotalMinor: 12_000,
    taxBehavior: "exclusive",
    taxRateBps: 1_800,
    taxMinor: 2_160,
    totalMinor: 14_160,
  });

  assert.deepEqual(calculateWhiteLabelCustomerInvoice({
    recurringAmountMinor: 12_000,
    taxBehavior: "inclusive",
    taxRateBps: 2_000,
  }), {
    recurringAmountMinor: 12_000,
    setupFeeMinor: 0,
    subtotalMinor: 12_000,
    taxBehavior: "inclusive",
    taxRateBps: 2_000,
    taxMinor: 2_000,
    totalMinor: 12_000,
  });
  assert.throws(() => calculateWhiteLabelCustomerInvoice({
    recurringAmountMinor: 10_000,
    taxBehavior: "unspecified",
    taxRateBps: 1_800,
  }), /set the retail plan tax behavior/i);
});

test("customer invoice settlement requires captured payment and exact tenant, order, amount, and currency", () => {
  const invoice = {
    id: "invoice-1",
    accountId: "account-1",
    subscriptionId: "subscription-1",
    orgId: "org-1",
    status: "open",
    totalMinor: 11_800,
    currency: "INR",
    razorpayOrderId: "order-1",
    razorpayPaymentId: "",
  };
  const order: WhiteLabelCustomerRazorpayOrder = {
    id: "order-1",
    amount: 11_800,
    currency: "INR",
    status: "paid",
    notes: {
      kind: "white_label_customer_invoice",
      whiteLabelCustomerInvoiceId: "invoice-1",
      whiteLabelAccountId: "account-1",
      whiteLabelSubscriptionId: "subscription-1",
      orgId: "org-1",
    },
  };
  const payment: WhiteLabelCustomerRazorpayPayment = {
    id: "payment-1",
    order_id: "order-1",
    amount: 11_800,
    currency: "INR",
    status: "captured",
  };
  assert.doesNotThrow(() => assertWhiteLabelCustomerPaymentMatches(invoice, order, payment));
  assert.throws(() => assertWhiteLabelCustomerPaymentMatches(
    invoice,
    { ...order, notes: { ...order.notes, orgId: "org-2" } },
    payment,
  ), /does not match/i);
  assert.throws(() => assertWhiteLabelCustomerPaymentMatches(
    invoice,
    order,
    { ...payment, amount: 11_799 },
  ), /does not match/i);
  assert.throws(() => assertWhiteLabelCustomerPaymentMatches(
    invoice,
    order,
    { ...payment, status: "authorized" },
  ), /does not match/i);
});

test("customer invoices declare the idempotency and provider-identity indexes required in production", () => {
  const indexes = WhiteLabelCustomerInvoiceModel.schema.indexes();
  const hasUnique = (keys: Record<string, number>) => indexes.some(([fields, options]) => (
    options.unique === true
    && Object.entries(keys).every(([key, direction]) => fields[key] === direction)
  ));
  assert.equal(hasUnique({ subscriptionId: 1, periodStart: 1, kind: 1, sequence: 1 }), true);
  assert.equal(hasUnique({ replacementOfInvoiceId: 1 }), true);
  assert.equal(hasUnique({ razorpayOrderId: 1 }), true);
  assert.equal(hasUnique({ razorpayPaymentId: 1 }), true);
  assert.equal(hasUnique({ razorpayTransferId: 1 }), true);
});

test("white-label tenancy models declare their production uniqueness boundaries", () => {
  const uniqueIndex = (model: { schema: { indexes(): Array<[Record<string, number>, Record<string, unknown>]> } }, keys: Record<string, number>) => (
    model.schema.indexes().some(([fields, options]) => (
      options.unique === true
      && Object.entries(keys).every(([key, direction]) => fields[key] === direction)
    ))
  );
  assert.equal(uniqueIndex(WhiteLabelAccountModel, { ownerOrgId: 1 }), true);
  assert.equal(uniqueIndex(WhiteLabelDomainModel, { hostname: 1 }), true);
  assert.equal(uniqueIndex(WhiteLabelSubscriptionModel, { orgId: 1 }), true);
  assert.equal(uniqueIndex(OrganizationModel, { whiteLabelAccountId: 1, externalCustomerId: 1 }), true);
});

test("customer refund reconciliation uses provider cumulative totals and is retry-idempotent", () => {
  assert.equal(calculateWhiteLabelCustomerRefundTotal({
    totalMinor: 10_000,
    refundedMinor: 2_000,
    lastRefundId: "refund-1",
    refundId: "refund-1",
    refundAmount: 2_000,
  }), 2_000);
  assert.equal(calculateWhiteLabelCustomerRefundTotal({
    totalMinor: 10_000,
    refundedMinor: 2_000,
    lastRefundId: "refund-1",
    refundId: "refund-2",
    refundAmount: 3_000,
  }), 5_000);
  assert.equal(calculateWhiteLabelCustomerRefundTotal({
    totalMinor: 10_000,
    refundedMinor: 2_000,
    lastRefundId: "refund-1",
    refundId: "refund-2",
    refundAmount: 3_000,
    providerCumulativeRefund: 10_000,
  }), 10_000);
});

test("included-only and overage-disabled plans block calls once included minutes are exhausted even with wallet credits", async (context) => {
  const previous = env.whiteLabelEnabled;
  env.whiteLabelEnabled = true;
  let usedSeconds = 30 * 60;
  let usagePricingSnapshot: Record<string, unknown> = { mode: "included_only", overageEnabled: true };
  const subscription = {
    status: "active",
    priceSnapshot: { currency: "USD" },
    allowancesSnapshot: { includedMinutes: 50 },
    get usagePricingSnapshot() { return usagePricingSnapshot; },
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: new Date("2099-12-01T00:00:00Z"),
  };
  context.mock.method(OrganizationModel, "findById", () => ({ select: () => ({ lean: async () => ({ whiteLabelAccountId: "partner" }) }) }) as never);
  context.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({ select: () => ({ lean: async () => subscription }) }) as never);
  context.mock.method(CreditWalletModel, "findOneAndUpdate", async () => ({ balanceCredits: 250, currency: "USD" }) as never);
  context.mock.method(CallDetailRecordModel, "aggregate", async () => [{ seconds: usedSeconds }] as never);
  try {
    await assert.doesNotReject(() => assertCallCapacity("customer-org"));
    usedSeconds = 50 * 60;
    await assert.rejects(() => assertCallCapacity("customer-org"), /overage is disabled/i);
    usagePricingSnapshot = { mode: "cost_markup", overageEnabled: false };
    await assert.rejects(() => assertCallCapacity("customer-org"), /overage is disabled/i);
    usagePricingSnapshot = { mode: "cost_markup", overageEnabled: true };
    await assert.doesNotReject(() => assertCallCapacity("customer-org"));
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("public widget capacity enforces white-label subscription, outbound feature, models, and monthly/concurrent limits", async (context) => {
  const previous = env.whiteLabelEnabled;
  env.whiteLabelEnabled = true;
  let sub: Record<string, unknown> = {
    status: "active",
    priceSnapshot: { currency: "USD" },
    allowancesSnapshot: { includedMinutes: 10 },
    usagePricingSnapshot: { mode: "cost_markup", overageEnabled: true },
    limitsSnapshot: { monthlyMinutes: 60, concurrentCalls: 2 },
    featuresSnapshot: { outboundCalling: false },
    modelAccessSnapshot: {
      stt: ["openai:gpt-4o-mini-transcribe"],
      llm: ["openai:gpt-realtime-2.1", "openai:gpt-4.1-mini"],
      tts: ["openai:gpt-4o-mini-tts"],
    },
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: new Date("2099-12-01T00:00:00Z"),
  };
  let activeCalls = 0;
  let usedSeconds = 0;
  context.mock.method(OrganizationModel, "findById", () => ({ select: () => ({ lean: async () => ({ lifecycleStatus: "active", whiteLabelAccountId: "partner" }) }) }) as never);
  context.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({ select: () => ({ lean: async () => sub }) }) as never);
  context.mock.method(CallDetailRecordModel, "aggregate", async () => [{ seconds: usedSeconds }] as never);
  context.mock.method(CallDetailRecordModel, "countDocuments", async () => activeCalls as never);
  const agent = { pipelineMode: "realtime", realtimeProvider: "openai", realtimeModel: "gpt-realtime-2.1" };
  try {
    await assert.rejects(() => assertWhiteLabelPublicCallCapacity("customer-org", agent), /Outbound and web calling are not enabled/i);

    sub = { ...sub, featuresSnapshot: { outboundCalling: true } };
    await assert.doesNotReject(() => assertWhiteLabelPublicCallCapacity("customer-org", agent));

    activeCalls = 2;
    await assert.rejects(() => assertWhiteLabelPublicCallCapacity("customer-org", agent), /concurrency limit/i);

    activeCalls = 0;
    usedSeconds = 60 * 60;
    await assert.rejects(() => assertWhiteLabelPublicCallCapacity("customer-org", agent), /Monthly call allowance/i);
  } finally {
    env.whiteLabelEnabled = previous;
  }
});

test("requireWhiteLabelCallCapacity blocks included-only plans once included minutes are spent even if overageEnabled was left true", async (context) => {
  context.mock.method(VoiceAgentModel, "findOne", () => ({ select: () => ({ lean: async () => null }) }) as never);
  context.mock.method(CallDetailRecordModel, "aggregate", async () => [{ seconds: 25 * 60 }] as never);
  context.mock.method(CallDetailRecordModel, "countDocuments", async () => 0 as never);
  let forwardedError: unknown;
  await requireWhiteLabelCallCapacity(
    {
      organization: { id: "customer-org" },
      body: {},
      params: {},
      whiteLabelSubscription: {
        subscriptionId: "sub-1",
        accountId: "acc-1",
        brandId: "brand-1",
        planId: "plan-1",
        planKey: "starter",
        planVersion: 1,
        status: "active",
        price: { currency: "USD" },
        allowances: { includedMinutes: 25 },
        usagePricing: { mode: "included_only", overageEnabled: true },
        limits: { monthlyMinutes: 500, concurrentCalls: 5 },
        features: {},
      },
    } as never,
    {} as never,
    (error?: unknown) => { forwardedError = error; },
  );
  assert.equal((forwardedError as { statusCode?: number })?.statusCode, 402);
});

test("resetPassword marks emailVerified true upon redeeming a valid activation or reset token", async (context) => {
  const userRecord: Record<string, unknown> & { save: () => Promise<void> } = {
    _id: "user-1",
    emailVerified: false,
    passwordHash: "",
    passwordResetTokenHash: "hashed",
    passwordResetExpires: new Date(Date.now() + 60_000),
    loginAttempts: 2,
    lockUntil: new Date(Date.now() + 60_000),
    async save() {},
  };
  context.mock.method(UserModel, "findOne", () => ({
    select: async () => userRecord,
  }) as never);
  context.mock.method(AuthSessionModel, "updateMany", async () => ({ modifiedCount: 1 }) as never);

  let statusCode = 0;
  const response = {
    status(code: number) { statusCode = code; return this; },
    end() {},
  };
  await resetPassword({ body: { token: "raw-token", password: "StrongPassword!1" } } as never, response as never);
  assert.equal(statusCode, 204);
  assert.equal(userRecord.emailVerified, true);
  assert.equal(userRecord.passwordResetTokenHash, "");
  assert.equal(userRecord.loginAttempts, 0);
});

test("provisionPartnerCustomer rejects USD plans under retail Route full_amount settlement", async (context) => {
  const account = {
    _id: "acc-1",
    id: "acc-1",
    status: "active",
    entitlements: { customCustomerPricing: false, developerApi: true, advancedAnalytics: true },
    limits: { customerOrganizations: 10, agentsPerCustomer: 10, membersPerCustomer: 10, phoneNumbersPerCustomer: 5, concurrentCallsPerCustomer: 5, monthlyMinutesPerCustomer: 1000 },
    retailBilling: { enabled: true, transferMode: "full_amount", taxRateBps: 0 },
  };
  context.mock.method(WhiteLabelAccountModel, "findOne", async () => account as never);
  context.mock.method(UserModel, "findOne", () => ({ select: async () => null }) as never);
  context.mock.method(WhiteLabelBrandModel, "findOne", async () => ({ _id: "65f000000000000000000001", id: "65f000000000000000000001", status: "published" }) as never);
  context.mock.method(WhiteLabelPlanModel, "findOne", async () => ({
    _id: "65f000000000000000000002",
    id: "65f000000000000000000002",
    name: "USD Starter",
    key: "usd-starter",
    version: 1,
    status: "published",
    price: { currency: "USD", billingType: "subscription", interval: "month", recurringAmountMinor: 1000, setupFeeMinor: 0, trialDays: 0, taxBehavior: "exclusive" },
    usagePricing: { mode: "cost_markup", markupBps: 0, perMinuteAmountMinor: 0, minimumCallAmountMinor: 0, overageEnabled: true },
    allowances: { includedCredits: 0, includedMinutes: 0 },
    limits: { agents: 1, members: 1, phoneNumbers: 0, concurrentCalls: 1, monthlyMinutes: 100, knowledgeSources: 0, apiKeys: 0 },
    features: {},
    toObject() { return this; },
  }) as never);
  context.mock.method(WhiteLabelDomainModel, "findOne", () => ({ sort: async () => ({ hostname: "app.partner.test" }) }) as never);
  context.mock.method(OrganizationModel, "exists", async () => null as never);

  await assert.rejects(
    () => provisionPartnerCustomer({
      organization: { id: "owner-org" },
      body: {
        organizationName: "Acme Client",
        ownerEmail: "client@acme.test",
        ownerName: "Client Owner",
        brandId: "65f000000000000000000001",
        planId: "65f000000000000000000002",
        billingMode: "retail",
      },
    } as never, {} as never),
    /supports INR customer plans only/i,
  );
});

test("resendPartnerCustomerActivation never mints a reset token for already credentialed accounts and issues setup links for pending owners", async (context) => {
  const prevResend = env.resendApiKey;
  const prevUser = env.emailUser;
  const prevPass = env.emailPass;
  env.resendApiKey = "";
  env.emailUser = "";
  env.emailPass = "";
  const account = { _id: "65f000000000000000000010", id: "65f000000000000000000010", status: "active" };
  let savedCount = 0;
  let ownerState: Record<string, unknown> & { save: () => Promise<void> } = {
    _id: "user-verified",
    id: "user-verified",
    name: "Verified User",
    email: "verified@acme.test",
    emailVerified: false,
    passwordHash: "already-has-password",
    passwordResetTokenHash: "",
    async save() { savedCount += 1; },
  };
  context.mock.method(WhiteLabelAccountModel, "findOne", async () => account as never);
  context.mock.method(OrganizationModel, "findOne", async () => ({
    _id: "65f000000000000000000011",
    id: "65f000000000000000000011",
    name: "Acme Workspace",
    ownerUserId: "user-1",
    whiteLabelBrandId: "65f000000000000000000012",
  }) as never);
  context.mock.method(UserModel, "findById", () => ({ select: async () => ownerState }) as never);
  context.mock.method(WhiteLabelBrandModel, "findOne", async () => ({
    _id: "65f000000000000000000012",
    branding: {
      productName: "PartnerVoice",
      companyName: "PartnerVoice Technologies",
      primaryColor: "#118778",
      secondaryColor: "#14231f",
      accentColor: "#118778",
    },
    support: { email: "help@partner.test" },
    email: { fromName: "PartnerVoice", fromAddress: "", sendingDomainStatus: "unverified", resendApiKey: "" },
    legal: { legalBusinessName: "PartnerVoice Technologies" },
  }) as never);
  context.mock.method(WhiteLabelDomainModel, "findOne", () => ({ sort: async () => ({ hostname: "portal.partner.test" }) }) as never);
  context.mock.method(EmailDeliveryModel, "create", async () => ({ status: "preview" }) as never);
  context.mock.method(AuditLogModel, "create", async () => ({}) as never);

  let jsonPayload: Record<string, unknown> = {};
  const response = { json(body: Record<string, unknown>) { jsonPayload = body; } };
  try {
    await resendPartnerCustomerActivation({
      user: { id: "partner-admin", email: "partner@test.com" },
      organization: { id: "partner-org" },
      params: { orgId: "65f000000000000000000011" },
      headers: {},
    } as never, response as never);
    assert.equal(savedCount, 0);
    assert.equal(jsonPayload.alreadyActivated, true);
    assert.equal(jsonPayload.activationUrl, "https://portal.partner.test/login");

    ownerState = {
      _id: "user-pending",
      id: "user-pending",
      name: "Pending Owner",
      email: "pending@acme.test",
      emailVerified: false,
      passwordHash: "",
      passwordResetTokenHash: "",
      async save() { savedCount += 1; },
    };
    await resendPartnerCustomerActivation({
      user: { id: "partner-admin", email: "partner@test.com" },
      organization: { id: "partner-org" },
      params: { orgId: "65f000000000000000000011" },
      headers: {},
    } as never, response as never);
    assert.equal(savedCount, 1);
    assert.equal(jsonPayload.alreadyActivated, false);
    assert.match(String(jsonPayload.activationUrl), /^https:\/\/portal\.partner\.test\/reset-password\?token=/);
    assert.ok(String(ownerState.passwordResetTokenHash).length > 10);
  } finally {
    env.resendApiKey = prevResend;
    env.emailUser = prevUser;
    env.emailPass = prevPass;
  }
});

test("previewInvitation and completeInvitation enforce white-label isolation and protect existing credentialed accounts", async (context) => {
  const prevWl = env.whiteLabelEnabled;
  env.whiteLabelEnabled = false;
  context.mock.method(OrganizationInvitationModel, "findOne", () => ({
    select: async () => ({
      _id: "inv-1",
      id: "inv-1",
      orgId: "org-wl",
      email: "teammate@acme.test",
      role: "member",
      expiresAt: new Date(Date.now() + 60_000),
    }),
  }) as never);
  context.mock.method(OrganizationModel, "findById", async () => ({
    _id: "org-wl",
    id: "org-wl",
    name: "Acme WL",
    lifecycleStatus: "active",
    whiteLabelAccountId: undefined,
  }) as never);
  context.mock.method(UserModel, "findOne", () => ({
    select: () => Object.assign(Promise.resolve({ _id: "u1", passwordHash: "hashed" }), {
      lean: async () => ({ _id: "u1", passwordHash: "hashed" }),
    }),
  }) as never);

  let previewBody: Record<string, unknown> = {};
  try {
    await previewInvitation(
      { query: { token: "invite-tok" }, headers: {}, hostname: "localhost" } as never,
      { json(body: Record<string, unknown>) { previewBody = body; } } as never,
    );
    assert.equal(previewBody.hasAccount, true);
    assert.equal(previewBody.organizationName, "Acme WL");

    await assert.rejects(
      () => completeInvitation(
        { body: { token: "invite-tok", name: "Existing Teammate", password: "NewPassword123!" }, headers: {}, hostname: "localhost" } as never,
        {} as never,
      ),
      /account already exists.*Sign in/i,
    );
  } finally {
    env.whiteLabelEnabled = prevWl;
  }
});
