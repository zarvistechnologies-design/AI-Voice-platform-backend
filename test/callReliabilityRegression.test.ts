import assert from "node:assert/strict";
import test from "node:test";

import {
  callBillingCurrency,
  usdToWalletRate,
} from "../src/services/billingCurrency.js";
import { compatibleGeminiRealtimeVoice } from "../src/services/geminiRealtimeVoice.js";

test("Gemini Realtime keeps supported voices and rejects cross-provider voices", () => {
  assert.equal(compatibleGeminiRealtimeVoice("Puck"), "Puck");
  assert.equal(compatibleGeminiRealtimeVoice("Aoede"), "Aoede");
  assert.equal(compatibleGeminiRealtimeVoice("Achernar"), "Puck");
  assert.equal(compatibleGeminiRealtimeVoice("alloy"), "Puck");
});

test("settled call charges use ledger currency instead of source-cost currency", () => {
  assert.equal(callBillingCurrency({
    settled: true,
    transactionCurrency: "INR",
    costCurrency: "USD",
    fallbackCurrency: "USD",
  }), "INR");
  assert.equal(callBillingCurrency({
    settled: false,
    transactionCurrency: "INR",
    costCurrency: "USD",
    fallbackCurrency: "INR",
  }), "USD");
});

test("USD provider costs are converted before entering an INR wallet", () => {
  assert.equal(usdToWalletRate("INR", 96.5), 96.5);
  assert.equal(usdToWalletRate("USD", 96.5), 1);
});
