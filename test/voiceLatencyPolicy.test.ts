import assert from "node:assert/strict";
import test from "node:test";

import {
  needsComplexVoiceReasoning,
  providerLatencyTransports,
  resolveGeminiVoiceThinking,
  resolveOpenAiVoiceReasoningEffort,
  resolvePipelineTurnStrategy,
  resolveSarvamVoiceReasoningEffort,
  shouldUseOpenAiResponsesWebSocket,
  supportsAdaptivePipelineInterruptions,
} from "../src/services/voiceLatencyPolicy.js";

test("uses Deepgram Flux endpointing instead of adding a second VAD wait", () => {
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "deepgram",
    sttModel: "flux-general-en",
    languageCodes: ["en-IN"],
  }), "flux_stt");
});

test("uses Sarvam Realtime provider endpointing without changing the legacy path", () => {
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "sarvam",
    sttModel: "saaras:v3",
    languageCodes: ["en-IN", "ta-IN"],
    sarvamRealtimeSttEnabled: true,
  }), "provider_stt");
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "sarvam",
    sttModel: "saaras:v3-realtime",
    languageCodes: [],
    multilingualWithoutLanguageAllowlist: true,
  }), "provider_stt");
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "sarvam",
    sttModel: "saaras:v3",
    languageCodes: ["en-IN", "ta-IN"],
  }), "vad");
});

test("uses ElevenLabs Scribe provider endpointing", () => {
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "elevenlabs",
    sttModel: "scribe_v2_realtime",
    languageCodes: ["en-IN"],
  }), "provider_stt");
});

test("uses semantic audio endpointing only for supported language allowlists", () => {
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    languageCodes: ["en-IN", "hi-IN"],
  }), "semantic_audio");
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "sarvam",
    sttModel: "saaras:v3",
    languageCodes: ["en-IN", "ta-IN"],
  }), "vad");
  assert.equal(resolvePipelineTurnStrategy({
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    languageCodes: ["en-IN"],
    multilingualWithoutLanguageAllowlist: true,
  }), "vad");
});

test("enables adaptive interruptions only for word-aligned streaming STT", () => {
  assert.equal(supportsAdaptivePipelineInterruptions("deepgram"), true);
  assert.equal(supportsAdaptivePipelineInterruptions("elevenlabs"), true);
  assert.equal(supportsAdaptivePipelineInterruptions("openai"), false);
  assert.equal(supportsAdaptivePipelineInterruptions("sarvam"), false);
});

test("describes the effective low-latency transports for every pipeline provider", () => {
  assert.deepEqual(providerLatencyTransports({
    llmProvider: "openai",
    sttProvider: "openai",
    ttsProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    useOpenAiResponsesWebSocket: true,
  }), {
    llmTransport: "responses_websocket",
    sttTransport: "realtime_websocket",
    ttsTransport: "http_audio_stream",
  });

  assert.deepEqual(providerLatencyTransports({
    llmProvider: "gemini",
    sttProvider: "elevenlabs",
    ttsProvider: "elevenlabs",
    sttModel: "scribe_v2_realtime",
    ttsModel: "eleven_flash_v2_5",
  }), {
    llmTransport: "generate_content_stream",
    sttTransport: "realtime_websocket",
    ttsTransport: "persistent_multistream_websocket",
  });

  assert.deepEqual(providerLatencyTransports({
    llmProvider: "sarvam",
    sttProvider: "sarvam",
    ttsProvider: "sarvam",
    sttModel: "saaras:v3",
    ttsModel: "bulbul:v3",
    sarvamRealtimeSttEnabled: true,
  }), {
    llmTransport: "openai_compatible_http_stream",
    sttTransport: "realtime_websocket_with_legacy_fallback",
    ttsTransport: "websocket_per_turn",
  });

  assert.equal(providerLatencyTransports({
    llmProvider: "sarvam",
    sttProvider: "sarvam",
    ttsProvider: "sarvam",
  }).sttTransport, "legacy_websocket_final_only");

  assert.deepEqual(providerLatencyTransports({
    llmProvider: "openai",
    sttProvider: "openai",
    sttModel: "whisper-1",
    ttsProvider: "elevenlabs",
    ttsModel: "eleven_v3",
  }), {
    llmTransport: "http_stream",
    sttTransport: "vad_segmented_http",
    ttsTransport: "http_audio_stream",
  });
});

test("balances GPT-5.6 reasoning against voice TTFT", () => {
  assert.equal(resolveOpenAiVoiceReasoningEffort({
    model: "gpt-5.6-luna",
    configuredEffort: "auto",
    needsReasoning: false,
  }), "none");
  assert.equal(resolveOpenAiVoiceReasoningEffort({
    model: "gpt-5.6-luna",
    configuredEffort: "auto",
    needsReasoning: true,
  }), "low");
  assert.equal(resolveOpenAiVoiceReasoningEffort({
    model: "gpt-4.1-mini",
    configuredEffort: "auto",
    needsReasoning: true,
  }), undefined);
});

test("enables bounded Gemini and Sarvam reasoning for complex voice agents", () => {
  assert.equal(needsComplexVoiceReasoning({
    knowledgeSourceCount: 0,
    hasLiveTools: false,
    calendarEnabled: false,
    sheetsEnabled: false,
    transferEnabled: false,
    dtmfEnabled: false,
  }), false);
  assert.equal(needsComplexVoiceReasoning({
    knowledgeSourceCount: 0,
    hasLiveTools: true,
    calendarEnabled: false,
    sheetsEnabled: false,
    transferEnabled: false,
    dtmfEnabled: false,
  }), true);

  assert.deepEqual(resolveGeminiVoiceThinking({
    model: "gemini-2.5-flash",
    needsReasoning: false,
  }), { kind: "budget", value: 0 });
  assert.deepEqual(resolveGeminiVoiceThinking({
    model: "gemini-2.5-flash",
    needsReasoning: true,
  }), { kind: "budget", value: 512 });
  assert.deepEqual(resolveGeminiVoiceThinking({
    model: "gemini-3-flash-preview",
    needsReasoning: false,
  }), { kind: "level", value: "minimal" });
  assert.deepEqual(resolveGeminiVoiceThinking({
    model: "gemini-3-flash-preview",
    needsReasoning: true,
  }), { kind: "level", value: "low" });
  assert.equal(resolveSarvamVoiceReasoningEffort(false), null);
  assert.equal(resolveSarvamVoiceReasoningEffort(true), "low");
});

test("uses Responses WebSocket only against the official compatible endpoint", () => {
  assert.equal(shouldUseOpenAiResponsesWebSocket({
    model: "gpt-5.6-luna",
    baseUrl: "https://api.openai.com/v1",
    enabled: true,
  }), true);
  assert.equal(shouldUseOpenAiResponsesWebSocket({
    model: "gpt-5.6-luna",
    baseUrl: "https://gateway.example.com/v1",
    enabled: true,
  }), false);
  assert.equal(shouldUseOpenAiResponsesWebSocket({
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    enabled: true,
  }), false);
});
