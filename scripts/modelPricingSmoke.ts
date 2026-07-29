import assert from "node:assert/strict";

import { effectiveModelSnapshot } from "../src/services/callRecordService.js";
import {
    defaultGeminiRealtimeModel,
    defaultOpenAIRealtimeModel,
    modelCatalog,
    normalizeGeminiRealtimeModel,
    normalizeOpenAIRealtimeModel,
} from "../src/services/modelCatalog.js";
import {
    calculateCallCost,
    missingPricingForModel,
    publishedTtsPricingForModel,
} from "../src/services/modelPricingService.js";
import { rememberElevenLabsVoiceRate } from "../src/services/elevenLabsPricingService.js";

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${label}: expected ${expected}, received ${actual}`);
}

const base = {
  llmProvider: "openai",
  llmModel: "gpt-4.1",
  llmInputTokens: 0,
  llmOutputTokens: 0,
  llmTokens: 0,
  sttProvider: "",
  sttModel: "",
  sttSeconds: 0,
  ttsProvider: "",
  ttsModel: "",
  ttsVoice: "",
  ttsCharacters: 0,
  ttsAudioSeconds: 0,
  durationSeconds: 0,
};

const realtime = calculateCallCost({
  ...base,
  llmModel: "gpt-realtime",
  modelUsage: [{
    type: "llm_usage",
    inputTokens: 1_000,
    inputCachedTokens: 100,
    inputAudioTokens: 600,
    inputCachedAudioTokens: 100,
    inputTextTokens: 400,
    outputTokens: 500,
    outputAudioTokens: 400,
    outputTextTokens: 100,
  }],
});
close(realtime.llm, 0.04484, "OpenAI Realtime mixed text/audio token cost");
assert.equal(realtime.pricing.llm.key, "openai:gpt-realtime");

const realtime21 = calculateCallCost({
  ...base,
  llmModel: "gpt-realtime-2.1",
  llmInputTokens: 1_000_000,
  llmOutputTokens: 1_000_000,
  llmTokens: 2_000_000,
});
close(realtime21.llm, 28, "OpenAI Realtime 2.1 text token cost");
assert.equal(realtime21.pricing.llm.key, "openai:gpt-realtime-2.1");

const openAIRealtimeCatalog = modelCatalog.realtime.find((provider) => provider.provider === "openai");
assert.deepEqual(openAIRealtimeCatalog?.models, [defaultOpenAIRealtimeModel, "gpt-realtime-2.1-mini"]);
assert.equal(normalizeOpenAIRealtimeModel("gpt-realtime"), defaultOpenAIRealtimeModel);
assert.equal(normalizeOpenAIRealtimeModel("gpt-realtime-2"), defaultOpenAIRealtimeModel);
assert.equal(normalizeOpenAIRealtimeModel("gpt-4o-realtime-preview"), defaultOpenAIRealtimeModel);
assert.equal(normalizeOpenAIRealtimeModel("gpt-4o-mini-realtime-preview"), "gpt-realtime-2.1-mini");

const geminiRealtimeCatalog = modelCatalog.realtime.find((provider) => provider.provider === "gemini");
assert.deepEqual(geminiRealtimeCatalog?.models, [defaultGeminiRealtimeModel]);
assert.equal(defaultGeminiRealtimeModel, "gemini-3.1-flash-live-preview");
assert.equal(
  normalizeGeminiRealtimeModel("gemini-2.5-flash-native-audio-preview-12-2025"),
  defaultGeminiRealtimeModel,
);
assert.equal(normalizeGeminiRealtimeModel("gemini-2.0-flash-live-001"), defaultGeminiRealtimeModel);

const geminiRealtime = calculateCallCost({
  ...base,
  llmProvider: "gemini",
  llmModel: defaultGeminiRealtimeModel,
  modelUsage: [{
    type: "llm_usage",
    provider: "gemini",
    model: "gemini-2.5-flash",
    inputAudioTokens: 1_000,
    outputAudioTokens: 1_000,
  }],
  isRealtime: true,
});
close(geminiRealtime.llm, 0.015, "Gemini Realtime 3.1 audio token cost");
assert.equal(geminiRealtime.pricing.llm.key, "gemini:gemini-3.1-flash-live-preview");

const gemini = calculateCallCost({
  ...base,
  llmProvider: "Gemini",
  llmModel: "gemini-2.5-flash",
  modelUsage: [{
    type: "llm_usage",
    provider: "Gemini",
    model: "gemini-2.5-flash",
    inputTokens: 1_000,
    inputCachedTokens: 800,
    outputTokens: 100,
  }],
});
close(gemini.llm, 0.000334, "Gemini 2.5 Flash cached input cost");

const sarvam = calculateCallCost({
  ...base,
  llmProvider: "api.sarvam.ai",
  llmModel: "sarvam-30b",
  llmInputTokens: 1_000_000,
  llmOutputTokens: 1_000_000,
  llmTokens: 2_000_000,
});
close(sarvam.llm, 12.5 / 83, "Sarvam provider alias and INR LLM rate");
assert.equal(sarvam.pricing.llm.key, "sarvam:sarvam-30b");

const speech = calculateCallCost({
  ...base,
  sttProvider: "deepgram",
  sttModel: "nova-3",
  sttSeconds: 60,
  ttsProvider: "sarvam",
  ttsModel: "bulbul:v3",
  ttsCharacters: 10_000,
});
close(speech.stt, 0.0048, "Deepgram Nova-3 per-second cost");
close(speech.tts, 30 / 83, "Sarvam Bulbul v3 character cost");

const sarvamStt = calculateCallCost({
  ...base,
  sttProvider: "sarvam",
  sttModel: "saaras:v3",
  sttSeconds: 60,
});
close(sarvamStt.stt, 0.5 / 83, "Sarvam STT INR hourly cost");

const realtimeTranslate = calculateCallCost({
  ...base,
  sttProvider: "openai",
  sttModel: "gpt-realtime-translate",
  sttSeconds: 60,
});
close(realtimeTranslate.stt, 0.034, "OpenAI Realtime Translate per-minute cost");

const elevenLabs = calculateCallCost({
  ...base,
  sttProvider: "elevenlabs",
  sttModel: "scribe_v2_realtime",
  sttSeconds: 60,
  ttsProvider: "elevenlabs",
  ttsModel: "eleven_flash_v2_5",
  ttsCharacters: 1_000,
});
close(elevenLabs.stt, 0.0065, "ElevenLabs Scribe v2 Realtime cost");
close(elevenLabs.tts, 0.05, "ElevenLabs Flash TTS cost");
assert.equal(
  publishedTtsPricingForModel("elevenlabs", "eleven_flash_v2_5")?.perThousandCharacters,
  0.05,
);
assert.equal(
  publishedTtsPricingForModel("elevenlabs", "eleven_v3")?.perThousandCharacters,
  0.1,
);

rememberElevenLabsVoiceRate("custom-rate-voice", 2);
const elevenLabsCustomRate = calculateCallCost({
  ...base,
  ttsProvider: "elevenlabs",
  ttsModel: "eleven_v3",
  ttsVoice: "custom-rate-voice",
  ttsCharacters: 1_000,
});
close(elevenLabsCustomRate.tts, 0.2, "ElevenLabs Voice Library custom rate multiplier");
assert.equal(elevenLabsCustomRate.pricing.tts.voiceMultiplier, 2);

const oneMinute = calculateCallCost({
  ...base,
  durationSeconds: 60,
});
close(oneMinute.providerCost, 0, "Provider cost excludes carrier-only duration");
close(oneMinute.telephony, 0, "Telephony is not billed in provider-cost-only mode");
close(oneMinute.platformFee, 0, "Platform fee is disabled");
close(oneMinute.customerCost, oneMinute.providerCost, "Total equals provider cost");

const zeroUsage = calculateCallCost(base);
close(zeroUsage.total, 0, "Zero usage costs zero");
assert.equal(zeroUsage.pricingStatus, "exact");

const oneSecondDeepgram = calculateCallCost({
  ...base,
  sttProvider: "deepgram",
  sttModel: "nova-3",
  sttSeconds: 1,
});
close(oneSecondDeepgram.stt, 0.0048 / 60, "Deepgram one-second boundary cost");

const unknownModel = calculateCallCost({
  ...base,
  llmModel: "unknown-paid-model",
  llmInputTokens: 1_000,
  llmTokens: 1_000,
});
assert.equal(unknownModel.pricingStatus, "unpriced");
assert.equal(unknownModel.llm, 0);
assert.equal(unknownModel.missingPricing[0]?.key, "openai:unknown-paid-model");

const selectableCatalogs = [
  ["llm", modelCatalog.realtime],
  ["llm", modelCatalog.llm],
  ["stt", modelCatalog.stt],
  ["tts", modelCatalog.tts],
] as const;
for (const [component, providers] of selectableCatalogs) {
  for (const provider of providers) {
    for (const model of provider.models) {
      assert.equal(
        missingPricingForModel(component, provider.provider, model),
        null,
        `Selectable ${component} model requires exact pricing: ${provider.provider}/${model}`,
      );
    }
  }
}
assert.ok(
  modelCatalog.llm.some(
    (provider) => provider.provider === "gemini" && provider.models.includes("gemini-2.5-flash"),
  ),
  "Gemini 2.5 Flash must remain selectable",
);

assert.deepEqual(
  effectiveModelSnapshot({
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: "gpt-realtime",
    llmProvider: "gemini",
    llmModel: "gemini-2.5-flash",
    sttProvider: "deepgram",
    sttModel: "nova-3",
    ttsProvider: "sarvam",
    ttsModel: "bulbul:v3",
    ttsVoice: "shubh",
  }),
  {
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: defaultOpenAIRealtimeModel,
    language: "",
    llmProvider: "openai",
    llmModel: defaultOpenAIRealtimeModel,
    sttProvider: "",
    sttModel: "",
    ttsProvider: "",
    ttsModel: "",
    ttsVoice: "shubh",
  },
);

console.log("Pricing smoke tests passed.");
