import assert from "node:assert/strict";
import test from "node:test";

import { calculateWhiteLabelUsageCharge } from "../src/services/billingService.js";
import { customerActivationEmail } from "../src/services/emailTemplates.js";
import { normalizeHostname } from "../src/services/whiteLabelService.js";
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
import { WhiteLabelSubscriptionModel } from "../src/models/WhiteLabelSubscription.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { env } from "../src/config/env.js";
import { isPlatformHostname } from "../src/services/whiteLabelService.js";
import { requireWhiteLabelEnabled } from "../src/middleware/whiteLabelEnabled.js";

const brand = {
  productName: "Acme Voice",
  companyName: "Acme Services",
  primaryColor: "#ffcc00",
  secondaryColor: "#111827",
  accentColor: "#a855f7",
  legalBusinessName: "Acme Services Private Limited",
};

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
    totalMinor: 66_400,
  });

  const minimumWins = calculateWhiteLabelPartnerInvoice({
    platformFeeMinor: 49_900,
    minimumCommitmentMinor: 10_000,
    usageWholesaleMinor: 2_000,
    includedCreditMinor: 500,
    wholesaleMarkupBps: 1_000,
  });
  assert.equal(minimumWins.committedUsageMinor, 10_000);
  assert.equal(minimumWins.totalMinor, 59_900);
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
