import assert from "node:assert/strict";
import test from "node:test";

import { campaignAmountInr } from "../src/services/campaignCurrencyService.js";

test("campaign reporting keeps INR amounts unchanged", () => {
  assert.equal(campaignAmountInr(1250.5, "INR", 96.5), 1250.5);
  assert.equal(campaignAmountInr(1250.5, "inr", 96.5), 1250.5);
});

test("campaign reporting converts legacy USD amounts to INR", () => {
  assert.equal(campaignAmountInr(2, "USD", 96.5), 193);
  assert.equal(campaignAmountInr(2, undefined, 96.5), 193);
});

test("campaign reporting rejects invalid monetary values", () => {
  assert.equal(campaignAmountInr("invalid", "USD", 96.5), 0);
  assert.equal(campaignAmountInr(-5, "INR", 96.5), 0);
});
