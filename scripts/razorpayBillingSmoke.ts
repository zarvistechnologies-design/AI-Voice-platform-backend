import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { env } from "../src/config/env.js";
import { razorpayBillingTestHelpers as billing } from "../src/controllers/razorpayBillingController.js";
import { rechargePricing } from "../src/utils/rechargePricing.js";

const payload = "order_test|pay_test";
const secret = "test-secret";
const signature = createHmac("sha256", secret).update(payload).digest("hex");

billing.verifyHmac(payload, signature, secret, "invalid");
assert.throws(() => billing.verifyHmac(payload, "0".repeat(64), secret, "invalid"), /invalid/);
assert.equal(billing.topUpCredits(10.125), 10.13);
assert.throws(() => billing.topUpCredits(0), /between \$1 and \$10,000/);
assert.throws(() => billing.topUpCredits(10_001), /between \$1 and \$10,000/);
assert.equal(billing.topUpRupees(10), 10);
assert.throws(() => billing.topUpRupees(9.99), /between ₹10 and ₹10,00,000/);
for (const [credits, subtotalMinor, taxMinor, totalMinor] of [
  [1, 100, 18, 118],
  [5, 500, 90, 590],
  [10, 1000, 180, 1180],
  [50, 5000, 900, 5900],
  [100, 10000, 1800, 11800],
  [10.13, 1013, 182, 1195],
  [1.25, 125, 23, 148],
  [10_000, 1_000_000, 180_000, 1_180_000],
]) {
  assert.deepEqual(rechargePricing(credits), { subtotalMinor, taxRateBps: 1800, taxMinor, totalMinor });
}
const taxedOrder = {
  id: "order_gst", amount: 1180, amount_paid: 1180, currency: "USD", status: "paid" as const,
  notes: { orgId: "org_test", kind: "credit_topup", credits: "10.00", subtotalMinor: "1000", taxRateBps: "1800", taxMinor: "180" },
};
assert.deepEqual(billing.topUpOrderPricing(taxedOrder), {
  credits: 10, subtotalMinor: 1000, taxRateBps: 1800, taxMinor: 180, totalMinor: 1180,
});
assert.deepEqual(billing.topUpOrderPricing({
  ...taxedOrder, amount: 1000, amount_paid: 1000,
  notes: { orgId: "org_test", kind: "credit_topup", credits: "10.00" },
}), { credits: 10, subtotalMinor: 1000, taxRateBps: 0, taxMinor: 0, totalMinor: 1000 });
for (const invalidOrder of [
  { ...taxedOrder, amount: 1000 },
  { ...taxedOrder, currency: "INR" },
  { ...taxedOrder, notes: { ...taxedOrder.notes, credits: "11.80" } },
  { ...taxedOrder, notes: { ...taxedOrder.notes, taxMinor: "0" } },
  { ...taxedOrder, notes: { ...taxedOrder.notes, taxRateBps: "0" } },
  { ...taxedOrder, notes: { kind: "credit_topup", credits: "10.00", taxMinor: "180" } },
  { ...taxedOrder, notes: { kind: "credit_topup", credits: "10.00" } },
]) {
  assert.throws(() => billing.topUpOrderPricing(invalidOrder), /GST metadata is invalid/);
}
const payment = { id: "pay_gst", order_id: taxedOrder.id, amount: 1000, currency: "USD", status: "captured" as const };
await assert.rejects(billing.persistOrderPayment(taxedOrder, payment), /does not match its order/);
await assert.rejects(billing.persistOrderPayment(taxedOrder, { ...payment, amount: 1180, status: "authorized" }), /not captured/);
assert.equal(billing.subscriptionStatus("authenticated"), "trialing");
assert.equal(billing.subscriptionStatus("pending"), "past_due");
assert.equal(billing.subscriptionStatus("active"), "active");
assert.equal(billing.subscriptionStatus("cancelled"), "cancelled");
assert.equal(billing.enterpriseMonthlyCredits, env.razorpayEnterpriseMonthlyUsd);
assert.equal(
  billing.enterpriseMonthlyPaise,
  Math.round(env.razorpayEnterpriseMonthlyUsd * env.costRates.inrPerUsd * 100),
);

console.log(JSON.stringify({
  passed: true,
  checks: [
    "valid signature accepted",
    "invalid signature rejected",
    "top-up limits enforced",
    "INR recharge minimum is ₹10",
    "18% GST and minor-unit rounding verified",
    "GST is excluded from wallet credits",
    "legacy orders preserve their original price",
    "invalid GST metadata and underpayments rejected",
    "subscription states mapped",
    "configured monthly plan converted to INR paise",
  ],
}));
