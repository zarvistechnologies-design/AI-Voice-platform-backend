import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { env } from "../src/config/env.js";
import { razorpayBillingTestHelpers as billing } from "../src/controllers/razorpayBillingController.js";

const payload = "order_test|pay_test";
const secret = "test-secret";
const signature = createHmac("sha256", secret).update(payload).digest("hex");

billing.verifyHmac(payload, signature, secret, "invalid");
assert.throws(() => billing.verifyHmac(payload, "0".repeat(64), secret, "invalid"), /invalid/);
assert.equal(billing.topUpCredits(10.125), 10.13);
assert.throws(() => billing.topUpCredits(0), /between \$1 and \$10,000/);
assert.throws(() => billing.topUpCredits(10_001), /between \$1 and \$10,000/);
assert.equal(billing.subscriptionStatus("authenticated"), "trialing");
assert.equal(billing.subscriptionStatus("pending"), "past_due");
assert.equal(billing.subscriptionStatus("active"), "active");
assert.equal(billing.subscriptionStatus("cancelled"), "cancelled");
assert.equal(billing.enterpriseMonthlyCredits, env.razorpayEnterpriseMonthlyUsd);
assert.equal(billing.enterpriseMonthlyCents, Math.round(env.razorpayEnterpriseMonthlyUsd * 100));

console.log(JSON.stringify({
  passed: true,
  checks: [
    "valid signature accepted",
    "invalid signature rejected",
    "top-up limits enforced",
    "subscription states mapped",
    "configured USD plan converted to cents",
  ],
}));
