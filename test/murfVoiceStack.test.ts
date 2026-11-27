import assert from "node:assert/strict";
import test from "node:test";

import {
  modelCatalog,
  murfLanguageLocale,
  murfSttLanguageCode,
  normalizeMurfSttModel,
  normalizeMurfTtsModel,
} from "../src/services/modelCatalog.js";
import {
  missingPricingForStack,
  publishedTtsPricingForModel,
} from "../src/services/modelPricingService.js";
import { buildMurfSttUrl } from "../src/services/murfSttService.js";
import {
  murfPitchFromSemitones,
  murfRateFromSpeed,
  murfStreamEndpoint,
  normalizeMurfLocale,
  normalizeMurfVoiceId,
} from "../src/services/murfTtsService.js";
import {
  providerLatencyTransports,
  resolvePipelineTurnStrategy,
} from "../src/services/voiceLatencyPolicy.js";

test("modelCatalog normalizes Murf STT and TTS models and exposes Murf entries", () => {
  assert.equal(normalizeMurfSttModel(""), "finch_indic_1.0");
  assert.equal(normalizeMurfSttModel("finch"), "finch_indic_1.0");
  assert.equal(normalizeMurfSttModel("finch-global"), "finch_global_1.0");
  assert.equal(normalizeMurfSttModel("finch_global_1.0"), "finch_global_1.0");

  assert.equal(normalizeMurfTtsModel(""), "falcon-2.1");
  assert.equal(normalizeMurfTtsModel("falcon"), "falcon-2.1");
  assert.equal(normalizeMurfTtsModel("falcon 2"), "falcon-2");
  assert.equal(normalizeMurfTtsModel("murf-falcon-2.1"), "falcon-2.1");

  const sttProvider = modelCatalog.stt.find((p) => p.provider === "murf");
  assert.ok(sttProvider, "Murf AI should be present in STT modelCatalog");
  assert.ok(sttProvider.models.includes("finch_indic_1.0"));
  assert.ok(sttProvider.models.includes("finch_global_1.0"));

  const ttsProvider = modelCatalog.tts.find((p) => p.provider === "murf");
  assert.ok(ttsProvider, "Murf AI should be present in TTS modelCatalog");
  assert.ok(ttsProvider.models.includes("falcon-2.1"));
  assert.ok(ttsProvider.voices.includes("en-US-gordon"));
  assert.ok(ttsProvider.voices.includes("en-IN-isha"));
});

test("Murf language and voice helpers map locales, Odia codes, and legacy aliases", () => {
  assert.equal(murfSttLanguageCode("English"), "en");
  assert.equal(murfSttLanguageCode("English (India)"), "en");
  assert.equal(murfSttLanguageCode("Hindi"), "hi");
  assert.equal(murfSttLanguageCode("od-IN"), "or");
  assert.equal(murfSttLanguageCode("Multilingual"), undefined);

  assert.equal(murfLanguageLocale("English"), "en-IN");
  assert.equal(murfLanguageLocale("English UK"), "en-UK");
  assert.equal(murfLanguageLocale("en-GB"), "en-UK");
  assert.equal(murfLanguageLocale("ar-SA"), "ar-XA");
  assert.equal(murfLanguageLocale("Multilingual"), undefined);

  assert.equal(normalizeMurfLocale("en-gb"), "en-UK");
  assert.equal(normalizeMurfLocale("ar-AE"), "ar-XA");
  assert.equal(normalizeMurfVoiceId("gordon"), "en-US-gordon");
  assert.equal(normalizeMurfVoiceId("isha"), "en-IN-isha");
  assert.equal(normalizeMurfVoiceId("hi-IN-khyati"), "hi-IN-khyati");
  assert.equal(normalizeMurfVoiceId(""), "en-US-gordon");
});

test("Murf STT URL builder selects regional WebSocket endpoints and query parameters", () => {
  const indicUrl = new URL(
    buildMurfSttUrl({
      apiKey: "test-key",
      model: "finch_indic_1.0",
      language: "hi-IN",
      bvc: true,
    }),
  );
  assert.equal(indicUrl.origin, "wss://in.api.murf.ai");
  assert.equal(indicUrl.pathname, "/v1/transcription/stream-input");
  assert.equal(indicUrl.searchParams.get("model"), "finch_indic_1.0");
  assert.equal(indicUrl.searchParams.get("language"), "hi");
  assert.equal(indicUrl.searchParams.get("bvc"), "true");

  const globalUrl = new URL(
    buildMurfSttUrl({
      apiKey: "test-key",
      model: "finch_global_1.0",
      language: "Multilingual",
    }),
  );
  assert.equal(globalUrl.origin, "wss://us-east.api.murf.ai");
  assert.equal(globalUrl.searchParams.get("model"), "finch_global_1.0");
  assert.equal(globalUrl.searchParams.get("language"), null);
  assert.equal(globalUrl.searchParams.get("bvc"), null);
});

test("Murf TTS stream endpoint and prosody conversions stay within Murf bounds", () => {
  assert.equal(murfStreamEndpoint("global"), "https://global.api.murf.ai/v1/speech/stream");
  assert.equal(murfStreamEndpoint("in"), "https://in.api.murf.ai/v1/speech/stream");
  assert.equal(murfStreamEndpoint("us-east!"), "https://us-east.api.murf.ai/v1/speech/stream");

  assert.equal(murfRateFromSpeed(1), 0);
  assert.equal(murfRateFromSpeed(2), 50);
  assert.equal(murfRateFromSpeed(0.5), -25);
  assert.equal(murfRateFromSpeed(3), 50);

  assert.equal(murfPitchFromSemitones(0), 0);
  assert.equal(murfPitchFromSemitones(10), 50);
  assert.equal(murfPitchFromSemitones(-10), -50);
  assert.equal(murfPitchFromSemitones(20), 50);
});

test("Murf STT and TTS models have complete pricing and latency policy definitions", () => {
  const falcon = publishedTtsPricingForModel("murf", "falcon-2.1");
  assert.ok(falcon);
  assert.equal(falcon.perMillionCharacters, 10);

  const missingIndic = missingPricingForStack({
    pipelineMode: "pipeline",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    sttProvider: "murf",
    sttModel: "finch_indic_1.0",
    ttsProvider: "murf",
    ttsModel: "falcon-2.1",
  });
  assert.equal(missingIndic.length, 0);

  const missingGlobal = missingPricingForStack({
    pipelineMode: "pipeline",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    sttProvider: "murf",
    sttModel: "finch_global_1.0",
    ttsProvider: "murf",
    ttsModel: "falcon-2",
  });
  assert.equal(missingGlobal.length, 0);

  assert.equal(
    resolvePipelineTurnStrategy({
      sttProvider: "murf",
      sttModel: "finch_indic_1.0",
      languageCodes: ["hi-IN"],
    }),
    "provider_stt",
  );
  assert.deepEqual(
    providerLatencyTransports({
      llmProvider: "openai",
      sttProvider: "murf",
      ttsProvider: "murf",
    }),
    {
      llmTransport: "http_stream",
      sttTransport: "realtime_websocket",
      ttsTransport: "http_audio_stream",
    },
  );
});
