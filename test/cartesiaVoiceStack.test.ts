import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../src/config/env.js";
import {
  cartesiaLanguageCode,
  modelCatalog,
  normalizeCartesiaSttModel,
} from "../src/services/modelCatalog.js";
import {
  canonicalPricingProvider,
  publishedTtsPricingForModel,
} from "../src/services/modelPricingService.js";

test("publishes Cartesia STT and TTS choices in the voice catalog", () => {
  const stt = modelCatalog.stt.find((provider) => provider.provider === "cartesia");
  const tts = modelCatalog.tts.find((provider) => provider.provider === "cartesia");

  assert.deepEqual(stt?.models, ["ink-2", "ink-whisper"]);
  assert.deepEqual(tts?.models, ["sonic-3.6"]);
  assert.equal(tts?.voices.length, 5);
});

test("selects the production Ink model that supports the configured language", () => {
  assert.equal(normalizeCartesiaSttModel("ink-2", "English"), "ink-2");
  assert.equal(normalizeCartesiaSttModel("ink-2", "Hindi"), "ink-whisper");
  assert.equal(cartesiaLanguageCode("Odia"), "or");
});

test("prices and canonicalizes Cartesia usage", () => {
  assert.equal(canonicalPricingProvider("Cartesia AI"), "cartesia");
  const pricing = publishedTtsPricingForModel("cartesia", "sonic-3.6");
  assert.equal(pricing?.perMillionCharacters, env.cartesiaUsdPerMillionCredits);
});
