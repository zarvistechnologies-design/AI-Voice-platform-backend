import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeElevenLabsTtsModel,
  normalizeGeminiTtsModel,
  normalizeSarvamLlmModel,
} from "../src/services/modelCatalog.js";
import { missingPricingForModel } from "../src/services/modelPricingService.js";

test("migrates saved Gemini 2.5 TTS agents to streaming Gemini 3.1", () => {
  assert.equal(
    normalizeGeminiTtsModel("gemini-2.5-flash-preview-tts"),
    "gemini-3.1-flash-tts-preview",
  );
  assert.equal(
    normalizeGeminiTtsModel("gemini-2.5-pro-preview-tts"),
    "gemini-3.1-flash-tts-preview",
  );
});

test("migrates ElevenLabs Turbo to the equivalent faster Flash model", () => {
  assert.equal(
    normalizeElevenLabsTtsModel("eleven_turbo_v2_5"),
    "eleven_flash_v2_5",
  );
  assert.equal(
    normalizeElevenLabsTtsModel("eleven_multilingual_v2"),
    "eleven_multilingual_v2",
  );
});

test("migrates retired Sarvam chat models to the voice-optimized model", () => {
  assert.equal(normalizeSarvamLlmModel("sarvam-30b"), "sarvam-105b-conversations");
  assert.equal(normalizeSarvamLlmModel("sarvam-m"), "sarvam-105b-conversations");
  assert.equal(normalizeSarvamLlmModel("sarvam-105b"), "sarvam-105b");
  assert.equal(
    missingPricingForModel("llm", "sarvam", "sarvam-105b-conversations"),
    null,
  );
});
