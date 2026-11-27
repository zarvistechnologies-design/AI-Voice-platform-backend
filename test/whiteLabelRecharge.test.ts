import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { WhiteLabelRechargeOrderModel } from "../src/models/WhiteLabelRechargeOrder.js";
import { WhiteLabelAccountModel } from "../src/models/WhiteLabelAccount.js";
import { WhiteLabelSubscriptionModel } from "../src/models/WhiteLabelSubscription.js";
import {
  effectiveCustomerBillingMode,
  resolveAccountRazorpayCredentials,
  type WhiteLabelCustomerRazorpayOrder,
  type WhiteLabelCustomerRazorpayPayment,
} from "../src/services/whiteLabelCustomerBillingService.js";
import {
  assertRechargePaymentMatches,
  calculateWhiteLabelRechargeRefund,
  verifyRechargeCheckoutSignature,
} from "../src/services/whiteLabelRechargeService.js";
import { encryptSecret } from "../src/utils/secretCrypto.js";

test("white-label recharge settlement checks tenant, account, order, amount, currency, and capture status", () => {
  const recharge = {
    id: "recharge-1",
    orgId: "org-1",
    accountId: "account-1",
    amountMinor: 200_000,
    currency: "INR",
    razorpayOrderId: "order_wl_1",
    razorpayPaymentId: "",
  };
  const order: WhiteLabelCustomerRazorpayOrder = {
    id: "order_wl_1",
    amount: 200_000,
    currency: "INR",
    status: "paid",
    notes: {
      kind: "white_label_recharge",
      rechargeId: "recharge-1",
      orgId: "org-1",
      whiteLabelAccountId: "account-1",
    },
  };
  const payment: WhiteLabelCustomerRazorpayPayment = {
    id: "pay_wl_1",
    order_id: "order_wl_1",
    amount: 200_000,
    currency: "INR",
    status: "captured",
  };

  assert.doesNotThrow(() => assertRechargePaymentMatches(recharge, order, payment));
  assert.throws(
    () => assertRechargePaymentMatches(recharge, { ...order, notes: { ...order.notes, orgId: "org-2" } }, payment),
    /does not match/i,
  );
  assert.throws(
    () => assertRechargePaymentMatches(recharge, { ...order, notes: { ...order.notes, whiteLabelAccountId: "account-2" } }, payment),
    /does not match/i,
  );
  assert.throws(
    () => assertRechargePaymentMatches(recharge, order, { ...payment, amount: 199_999 }),
    /does not match/i,
  );
  assert.throws(
    () => assertRechargePaymentMatches(recharge, order, { ...payment, currency: "USD" }),
    /does not match/i,
  );
  assert.throws(
    () => assertRechargePaymentMatches(recharge, order, { ...payment, status: "authorized" }),
    /does not match/i,
  );
});

test("white-label recharge signature verification accepts valid partner HMAC and rejects tampering", () => {
  const secret = "partner_secret_12345";
  const orderId = "order_wl_test";
  const paymentId = "pay_wl_test";
  const signature = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

  assert.doesNotThrow(() => verifyRechargeCheckoutSignature(orderId, paymentId, signature, secret));
  assert.throws(
    () => verifyRechargeCheckoutSignature(orderId, paymentId, "0".repeat(64), secret),
    /Invalid Razorpay payment signature/,
  );
});

test("resolveAccountRazorpayCredentials uses partner credentials in custom mode and never falls back silently", () => {
  const encryptedSecret = encryptSecret("rzp_secret_partner_abc");
  const encryptedWebhook = encryptSecret("whsec_partner_xyz");
  const resolved = resolveAccountRazorpayCredentials({
    retailBilling: {
      gatewayMode: "custom",
      customKeyId: "rzp_test_partner123",
      customKeySecretEncrypted: encryptedSecret,
      customWebhookSecretEncrypted: encryptedWebhook,
    },
  });
  assert.deepEqual(resolved, {
    keyId: "rzp_test_partner123",
    keySecret: "rzp_secret_partner_abc",
    webhookSecret: "whsec_partner_xyz",
    isCustom: true,
  });

  assert.throws(
    () =>
      resolveAccountRazorpayCredentials({
        retailBilling: {
          gatewayMode: "custom",
          customKeyId: "rzp_test_partner123",
          customKeySecretEncrypted: "",
        },
      }),
    /incomplete/i,
  );
});

test("WhiteLabelRechargeOrder and WhiteLabelAccount schemas declare recharge package and order uniqueness", () => {
  const indexes = WhiteLabelRechargeOrderModel.schema.indexes();
  const hasUnique = (keys: Record<string, number>) =>
    indexes.some(
      ([fields, options]) =>
        options.unique === true && Object.entries(keys).every(([key, dir]) => fields[key] === dir),
    );
  assert.equal(hasUnique({ razorpayOrderId: 1 }), true);
  assert.equal(hasUnique({ razorpayPaymentId: 1 }), true);
  assert.ok(WhiteLabelAccountModel.schema.path("rechargePackages"));
  assert.ok(WhiteLabelSubscriptionModel.schema.path("billingMode"));
});

test("effectiveCustomerBillingMode resolves explicit overrides and workspace fallbacks", () => {
  assert.equal(
    effectiveCustomerBillingMode(
      { retailBilling: { enabled: false, gatewayMode: "platform" }, rechargePackages: [] },
      { billingMode: "inherit" },
    ),
    "manual",
  );
  assert.equal(
    effectiveCustomerBillingMode(
      { retailBilling: { enabled: false, gatewayMode: "custom" }, rechargePackages: [{ active: true }] },
      { billingMode: "inherit" },
    ),
    "recharge",
  );
  assert.equal(
    effectiveCustomerBillingMode(
      { retailBilling: { enabled: true, gatewayMode: "custom" }, rechargePackages: [{ active: true }] },
      { billingMode: "manual" },
    ),
    "manual",
  );
  assert.equal(
    effectiveCustomerBillingMode(
      { retailBilling: { enabled: false, gatewayMode: "platform" }, rechargePackages: [] },
      { billingMode: "recharge" },
    ),
    "recharge",
  );
  assert.equal(
    effectiveCustomerBillingMode(
      { retailBilling: { enabled: false, gatewayMode: "custom" }, rechargePackages: [{ active: true }] },
      { billingMode: "retail" },
    ),
    "retail",
  );
});

test("calculateWhiteLabelRechargeRefund debits credits proportionally and stays idempotent on retries", () => {
  const first = calculateWhiteLabelRechargeRefund({
    amountMinor: 200_000,
    credits: 2_000,
    refundedMinor: 0,
    refundedCredits: 0,
    lastRefundId: "",
    refundId: "rfnd_1",
    refundAmount: 100_000,
  });
  assert.deepEqual(first, {
    nextRefundedMinor: 100_000,
    targetRefundedCredits: 1_000,
    deltaCredits: 1_000,
    fullRefund: false,
  });

  const retry = calculateWhiteLabelRechargeRefund({
    amountMinor: 200_000,
    credits: 2_000,
    refundedMinor: 100_000,
    refundedCredits: 1_000,
    lastRefundId: "rfnd_1",
    refundId: "rfnd_1",
    refundAmount: 100_000,
  });
  assert.equal(retry.deltaCredits, 0);
  assert.equal(retry.fullRefund, false);

  const second = calculateWhiteLabelRechargeRefund({
    amountMinor: 200_000,
    credits: 2_000,
    refundedMinor: 100_000,
    refundedCredits: 1_000,
    lastRefundId: "rfnd_1",
    refundId: "rfnd_2",
    refundAmount: 100_000,
  });
  assert.deepEqual(second, {
    nextRefundedMinor: 200_000,
    targetRefundedCredits: 2_000,
    deltaCredits: 1_000,
    fullRefund: true,
  });
});
