import assert from "node:assert/strict";

import { callChargeAdjustment } from "../src/services/billingService.js";

assert.deepEqual(callChargeAdjustment(0.1, []), { netCharged: 0, delta: 0.1 });
assert.deepEqual(callChargeAdjustment(0.1, [-0.1]), { netCharged: 0.1, delta: 0 });
assert.deepEqual(callChargeAdjustment(0.15, [-0.1]), { netCharged: 0.1, delta: 0.05 });
assert.deepEqual(callChargeAdjustment(0.06, [-0.1]), { netCharged: 0.1, delta: -0.04 });
assert.deepEqual(callChargeAdjustment(0.06, [-0.1, 0.04]), { netCharged: 0.06, delta: 0 });
assert.deepEqual(callChargeAdjustment(0.08, [-0.1, 0.04]), { netCharged: 0.06, delta: 0.02 });
assert.deepEqual(callChargeAdjustment(0, [-0.1]), { netCharged: 0.1, delta: -0.1 });

console.log(JSON.stringify({
  passed: true,
  checks: [
    "initial charge",
    "idempotent retry",
    "upward revision",
    "downward revision refund",
    "refund retry",
    "increase after refund",
    "full refund",
  ],
}));
