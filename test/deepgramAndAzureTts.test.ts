import assert from "node:assert/strict";
import test from "node:test";

import {
  modelCatalog,
  normalizeDeepgramTtsModel,
  normalizeAzureTtsModel,
  deepgramAuraVoices,
  azureVoices,
} from "../src/services/modelCatalog.js";
import { publishedTtsPricingForModel } from "../src/services/modelPricingService.js";

test("publishedTtsPricingForModel resolves Deepgram Aura rates", () => {
  const aura2 = publishedTtsPricingForModel("deepgram", "aura-2");
  assert.ok(aura2);
  assert.equal(aura2.perMillionCharacters, 15);

  const aura1 = publishedTtsPricingForModel("deepgram", "aura-1");
  assert.ok(aura1);
  assert.equal(aura1.perMillionCharacters, 15);

  // Specific voice name also resolves correctly to Aura rate
  const specificVoice = publishedTtsPricingForModel("deepgram", "aura-2-thalia-en");
  assert.ok(specificVoice);
  assert.equal(specificVoice.perMillionCharacters, 15);
});

test("publishedTtsPricingForModel resolves Azure Speech rates", () => {
  const azureNeural = publishedTtsPricingForModel("azure", "azure-neural");
  assert.ok(azureNeural);
  assert.equal(azureNeural.perMillionCharacters, 16);

  // Specific voice name also resolves correctly to Azure rate
  const specificVoice = publishedTtsPricingForModel("azure", "en-US-JennyNeural");
  assert.ok(specificVoice);
  assert.equal(specificVoice.perMillionCharacters, 16);
});

test("normalizeDeepgramTtsModel resolves models properly", () => {
  assert.equal(normalizeDeepgramTtsModel("aura-2"), "aura-2");
  assert.equal(normalizeDeepgramTtsModel("aura-1"), "aura-1");
  assert.equal(normalizeDeepgramTtsModel("aura"), "aura-1");
  assert.equal(normalizeDeepgramTtsModel(""), "aura-2");
});

test("normalizeAzureTtsModel resolves default neural model", () => {
  assert.equal(normalizeAzureTtsModel("anything"), "azure-neural");
});

test("modelCatalog contains deepgram and azure TTS providers", () => {
  const deepgramProvider = modelCatalog.tts.find((p) => p.provider === "deepgram");
  assert.ok(deepgramProvider, "Deepgram provider should be present in TTS catalog");
  assert.ok(deepgramProvider.voices.length > 0);
  assert.ok(deepgramProvider.voices.includes("aura-2-thalia-en" as any));

  const azureProvider = modelCatalog.tts.find((p) => p.provider === "azure");
  assert.ok(azureProvider, "Azure provider should be present in TTS catalog");
  assert.ok(azureProvider.voices.length > 0);
  assert.ok(azureProvider.voices.includes("en-US-JennyNeural" as any));
});

test("modelCatalog contains azure LLM and STT providers", async () => {
  const {
    normalizeAzureLlmModel,
    normalizeAzureSttModel,
  } = await import("../src/services/modelCatalog.js");
  const { missingPricingForStack } = await import("../src/services/modelPricingService.js");

  const azureLlm = modelCatalog.llm.find((p) => p.provider === "azure");
  assert.ok(azureLlm, "Azure provider should be present in LLM catalog");
  assert.ok(azureLlm.models.includes("gpt-4o-mini"));
  assert.ok(azureLlm.models.includes("gpt-4o"));

  const azureStt = modelCatalog.stt.find((p) => p.provider === "azure");
  assert.ok(azureStt, "Azure provider should be present in STT catalog");
  assert.ok(azureStt.models.includes("azure-speech-stt"));

  assert.equal(normalizeAzureLlmModel(""), "gpt-4o-mini");
  assert.equal(normalizeAzureLlmModel("gpt-4o"), "gpt-4o");
  assert.equal(normalizeAzureSttModel(""), "azure-speech-stt");

  const missing = missingPricingForStack({
    pipelineMode: "pipeline",
    llmProvider: "azure",
    llmModel: "gpt-4o-mini",
    sttProvider: "azure",
    sttModel: "azure-speech-stt",
    ttsProvider: "azure",
    ttsModel: "azure-neural",
  });
  assert.equal(missing.length, 0, `Expected all Azure components to be priced, but missing: ${JSON.stringify(missing)}`);
});

