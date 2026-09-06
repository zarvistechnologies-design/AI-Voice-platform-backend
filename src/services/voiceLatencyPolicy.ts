export type PipelineTurnStrategy =
  | "flux_stt"
  | "provider_stt"
  | "semantic_audio"
  | "vad";

export type ProviderLlmTransport =
  | "responses_websocket"
  | "generate_content_stream"
  | "openai_compatible_http_stream"
  | "http_stream"
  | "provider_stream";

export type ProviderSttTransport =
  | "realtime_websocket"
  | "realtime_websocket_with_legacy_fallback"
  | "legacy_websocket_final_only"
  | "vad_segmented_http"
  | "provider_stream";

export type ProviderTtsTransport =
  | "persistent_multistream_websocket"
  | "generate_content_audio_stream"
  | "websocket_per_turn"
  | "http_audio_stream"
  | "provider_stream";

export type ProviderLatencyTransports = {
  llmTransport: ProviderLlmTransport;
  sttTransport: ProviderSttTransport;
  ttsTransport: ProviderTtsTransport;
};

export type OpenAiVoiceReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high";

export type OpenAiVoiceReasoningSetting = OpenAiVoiceReasoningEffort | "auto";

export type GeminiVoiceThinking =
  | { kind: "budget"; value: number }
  | { kind: "level"; value: "minimal" | "low" };

export type VoiceChatItemSummary = {
  type: string;
  role?: string;
};

export type VoiceReasoningWorkload = {
  knowledgeSourceCount: number;
  hasLiveTools: boolean;
  calendarEnabled: boolean;
  sheetsEnabled: boolean;
  transferEnabled: boolean;
  dtmfEnabled: boolean;
};

const semanticTurnLanguageCodes = new Set([
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "tr",
  "zh",
]);

function baseLanguageCode(value: string) {
  return value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

export function resolvePipelineTurnStrategy(input: {
  sttProvider: string;
  sttModel: string;
  languageCodes: string[];
  multilingualWithoutLanguageAllowlist?: boolean;
  sarvamRealtimeSttEnabled?: boolean;
}): PipelineTurnStrategy {
  if (input.sttProvider === "deepgram" && input.sttModel.startsWith("flux-")) {
    return "flux_stt";
  }

  if (
    input.sttProvider === "elevenlabs" ||
    (input.sttProvider === "sarvam" &&
      (input.sarvamRealtimeSttEnabled || input.sttModel === "saaras:v3-realtime"))
  ) {
    // Scribe and Saaras Realtime already emit speech-boundary and final events.
    // Let the provider end the turn so a second local VAD wait is not added.
    return "provider_stt";
  }

  if (input.multilingualWithoutLanguageAllowlist || input.languageCodes.length === 0) {
    return "vad";
  }

  return input.languageCodes.every((code) => semanticTurnLanguageCodes.has(baseLanguageCode(code)))
    ? "semantic_audio"
    : "vad";
}

export function providerLatencyTransports(input: {
  llmProvider: string;
  sttProvider: string;
  ttsProvider: string;
  sttModel?: string;
  ttsModel?: string;
  useOpenAiResponsesWebSocket?: boolean;
  sarvamRealtimeSttEnabled?: boolean;
}): ProviderLatencyTransports {
  const llmProvider = input.llmProvider.trim().toLowerCase();
  const sttProvider = input.sttProvider.trim().toLowerCase();
  const ttsProvider = input.ttsProvider.trim().toLowerCase();
  const sttModel = input.sttModel?.trim().toLowerCase() ?? "";
  const ttsModel = input.ttsModel?.trim().toLowerCase() ?? "";

  const llmTransport: ProviderLlmTransport = llmProvider === "openai"
    ? input.useOpenAiResponsesWebSocket ? "responses_websocket" : "http_stream"
    : llmProvider === "gemini"
      ? "generate_content_stream"
      : llmProvider === "sarvam"
        ? "openai_compatible_http_stream"
        : "provider_stream";

  const sttTransport: ProviderSttTransport = sttProvider === "sarvam"
    ? input.sarvamRealtimeSttEnabled
      ? "realtime_websocket_with_legacy_fallback"
      : "legacy_websocket_final_only"
    : sttProvider === "openai" && sttModel === "whisper-1"
      ? "vad_segmented_http"
      : ["openai", "elevenlabs", "deepgram"].includes(sttProvider)
        ? "realtime_websocket"
        : "provider_stream";

  const ttsTransport: ProviderTtsTransport = ttsProvider === "elevenlabs"
    ? ttsModel === "eleven_v3"
      ? "http_audio_stream"
      : "persistent_multistream_websocket"
    : ttsProvider === "gemini"
      ? "generate_content_audio_stream"
      : ttsProvider === "sarvam"
        ? "websocket_per_turn"
        : ttsProvider === "openai"
          ? "http_audio_stream"
          : "provider_stream";

  return { llmTransport, sttTransport, ttsTransport };
}

export function supportsAdaptivePipelineInterruptions(sttProvider: string) {
  // These adapters expose word-aligned streaming transcripts. ElevenLabs is
  // configured with timestamps at construction time by the voice worker.
  return sttProvider === "deepgram" || sttProvider === "elevenlabs";
}

export function resolveOpenAiVoiceReasoningEffort(input: {
  model: string;
  configuredEffort: OpenAiVoiceReasoningSetting;
  needsReasoning: boolean;
}): OpenAiVoiceReasoningEffort | undefined {
  if (!input.model.startsWith("gpt-5")) return undefined;
  if (input.configuredEffort !== "auto") return input.configuredEffort;

  // GPT-5.6 supports `none`, which is the lowest-TTFT path for ordinary voice
  // conversation. Tool- or knowledge-heavy turns retain low reasoning so the
  // latency optimization does not come at the cost of incorrect actions.
  if (
    input.model.startsWith("gpt-5.6") ||
    ["gpt-5.4", "gpt-5.2", "gpt-5.1"].includes(input.model)
  ) {
    return input.needsReasoning ? "low" : "none";
  }
  return input.needsReasoning ? "low" : "minimal";
}

export function needsComplexVoiceReasoning(input: VoiceReasoningWorkload) {
  return input.knowledgeSourceCount > 0
    || input.hasLiveTools
    || input.calendarEnabled
    || input.sheetsEnabled
    || input.transferEnabled
    || input.dtmfEnabled;
}

export function resolveGeminiVoiceThinking(input: {
  model: string;
  needsReasoning: boolean;
}): GeminiVoiceThinking {
  if (input.model.startsWith("gemini-3")) {
    return {
      kind: "level",
      value: input.needsReasoning ? "low" : "minimal",
    };
  }

  // Gemini 2.5 uses token budgets instead of thinking levels. A bounded 512
  // token budget is enough to improve tool selection and short multi-step
  // planning without enabling the model's potentially much slower dynamic
  // budget. Pro cannot disable thinking, so its simple-turn floor remains 128.
  return {
    kind: "budget",
    value: input.needsReasoning
      ? 512
      : input.model === "gemini-2.5-pro" ? 128 : 0,
  };
}

export function voiceTurnNeedsToolResultReasoning(
  items: readonly VoiceChatItemSummary[],
) {
  // Tool availability alone must not put every conversational turn on a slow
  // reasoning path. Enable bounded reasoning only for the immediate model
  // continuation after a tool result. Internal developer/system messages may
  // be appended after that result, so skip those while inspecting the turn.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "function_call_output") return true;
    if (item.type === "function_call") continue;
    if (
      item.type === "message" &&
      (item.role === "developer" || item.role === "system")
    ) {
      continue;
    }
    return false;
  }
  return false;
}

export function resolveSarvamVoiceReasoningEffort(needsReasoning: boolean) {
  // Sarvam documents `low` as the voice-friendly reasoning level and `null`
  // as its non-thinking path. Reasoning tokens count against max_tokens.
  return needsReasoning ? "low" as const : null;
}

export function shouldUseOpenAiResponsesWebSocket(input: {
  model: string;
  baseUrl: string;
  enabled: boolean;
}) {
  if (!input.enabled || !input.model.startsWith("gpt-5.6")) return false;
  return supportsOpenAiPromptCacheKey(input.baseUrl);
}

export function supportsOpenAiPromptCacheKey(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}
