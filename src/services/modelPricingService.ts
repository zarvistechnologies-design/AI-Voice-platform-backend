import { env } from "../config/env.js";
import { elevenLabsVoiceRate } from "./elevenLabsPricingService.js";

export const MODEL_PRICING_VERSION = "2026-07-30-provider-cost-only-openai-legacy-realtime-rate";

type PricingSource = "catalog" | "override" | "account" | "not_applicable" | "unpriced";
type PricingComponent = "llm" | "stt" | "tts";
export type PricingStatus = "exact" | "estimated" | "unpriced";

type LlmRate = {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
  inputAudioPerMillionTokens?: number;
  cachedInputAudioPerMillionTokens?: number;
  outputAudioPerMillionTokens?: number;
  inputImagePerMillionTokens?: number;
  cachedInputImagePerMillionTokens?: number;
};

type SttRate = {
  perMinute?: number;
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
};

type TtsRate = {
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  inputTokensPerCharacter?: number;
  perMillionCharacters?: number;
  perMinute?: number;
  perMillionAudioTokens?: number;
  audioTokensPerSecond?: number;
  voiceMultipliers?: Record<string, number>;
};

type PricingOverrides = {
  llm?: Record<string, Partial<LlmRate>>;
  stt?: Record<string, Partial<SttRate>>;
  tts?: Record<string, Partial<TtsRate>>;
};

type ModelUsageItem = Partial<{
  type: string;
  provider: string;
  model: string;
  inputTokens: number;
  inputCachedTokens: number;
  inputAudioTokens: number;
  inputCachedAudioTokens: number;
  inputTextTokens: number;
  inputCachedTextTokens: number;
  inputImageTokens: number;
  inputCachedImageTokens: number;
  outputTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
  sessionDurationMs: number;
  charactersCount: number;
  audioDurationMs: number;
  estimated: boolean;
  note: string;
}>;

type PricingDetail = {
  source: PricingSource | "mixed";
  key: string;
  unit: string;
  provider?: string;
  model?: string;
  inputPerMillionTokens?: number;
  cachedInputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  inputAudioPerMillionTokens?: number;
  cachedInputAudioPerMillionTokens?: number;
  outputAudioPerMillionTokens?: number;
  inputImagePerMillionTokens?: number;
  cachedInputImagePerMillionTokens?: number;
  perMinute?: number;
  perMillionCharacters?: number;
  perMillionAudioTokens?: number;
  audioTokensPerSecond?: number;
  voiceMultiplier?: number;
  estimated?: boolean;
  note?: string;
  models?: PricingDetail[];
};

export type MissingPricing = {
  component: PricingComponent;
  provider: string;
  model: string;
  key: string;
  reason: string;
};

type CostResult = {
  cost: number;
  detail: PricingDetail;
  missingPricing?: MissingPricing;
};

export type CallCostInput = {
  llmProvider: string;
  llmModel: string;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmTokens: number;
  sttProvider: string;
  sttModel: string;
  sttLanguage?: string;
  sttSeconds: number;
  sttInputTokens?: number;
  sttOutputTokens?: number;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  ttsCharacters: number;
  ttsAudioSeconds: number;
  ttsInputTokens?: number;
  ttsOutputTokens?: number;
  durationSeconds: number;
  modelUsage?: ModelUsageItem[];
  // When true, every llm_usage item is re-priced against llmProvider/llmModel (the
  // configured realtime model) instead of the underlying model the SDK reports, so
  // realtime audio/text tokens are billed at realtime rates rather than text rates.
  isRealtime?: boolean;
};

function inrToUsd(value: number) {
  const inrPerUsd = Number.isFinite(env.costRates.inrPerUsd) && env.costRates.inrPerUsd > 0
    ? env.costRates.inrPerUsd
    : 83;
  return value / inrPerUsd;
}

function providerNote(provider: string) {
  return canonicalPricingProvider(provider) === "sarvam"
    ? `Sarvam INR catalog rate converted to USD using COST_INR_PER_USD=${env.costRates.inrPerUsd}.`
    : undefined;
}

function detailNote(...notes: Array<string | undefined>) {
  return notes.filter(Boolean).join(" ") || undefined;
}

const llmRates: Record<string, LlmRate> = {
  "openai:gpt-5.4": { inputPerMillionTokens: 2.5, cachedInputPerMillionTokens: 0.25, outputPerMillionTokens: 15 },
  "openai:gpt-5.4-pro": { inputPerMillionTokens: 15, outputPerMillionTokens: 120 },
  "openai:gpt-5.4-mini": { inputPerMillionTokens: 0.75, cachedInputPerMillionTokens: 0.075, outputPerMillionTokens: 4.5 },
  "openai:gpt-5.4-nano": { inputPerMillionTokens: 0.2, cachedInputPerMillionTokens: 0.02, outputPerMillionTokens: 1.25 },
  "openai:gpt-5.3-chat-latest": { inputPerMillionTokens: 1.75, cachedInputPerMillionTokens: 0.175, outputPerMillionTokens: 14 },
  "openai:gpt-5.2": { inputPerMillionTokens: 1.75, cachedInputPerMillionTokens: 0.175, outputPerMillionTokens: 14 },
  "openai:gpt-5.2-chat-latest": { inputPerMillionTokens: 1.75, cachedInputPerMillionTokens: 0.175, outputPerMillionTokens: 14 },
  "openai:gpt-5.1": { inputPerMillionTokens: 1.25, cachedInputPerMillionTokens: 0.125, outputPerMillionTokens: 10 },
  "openai:gpt-5.1-chat-latest": { inputPerMillionTokens: 1.25, cachedInputPerMillionTokens: 0.125, outputPerMillionTokens: 10 },
  "openai:gpt-5": { inputPerMillionTokens: 1.25, cachedInputPerMillionTokens: 0.125, outputPerMillionTokens: 10 },
  "openai:gpt-5-mini": { inputPerMillionTokens: 0.25, cachedInputPerMillionTokens: 0.025, outputPerMillionTokens: 2 },
  "openai:gpt-5-nano": { inputPerMillionTokens: 0.05, cachedInputPerMillionTokens: 0.005, outputPerMillionTokens: 0.4 },
  "openai:gpt-4.1": { inputPerMillionTokens: 2, cachedInputPerMillionTokens: 0.5, outputPerMillionTokens: 8 },
  "openai:gpt-4.1-mini": { inputPerMillionTokens: 0.4, cachedInputPerMillionTokens: 0.1, outputPerMillionTokens: 1.6 },
  "openai:gpt-4.1-nano": { inputPerMillionTokens: 0.1, cachedInputPerMillionTokens: 0.025, outputPerMillionTokens: 0.4 },
  "openai:gpt-4o": { inputPerMillionTokens: 2.5, cachedInputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-4o-mini": { inputPerMillionTokens: 0.15, cachedInputPerMillionTokens: 0.075, outputPerMillionTokens: 0.6 },
  "openai:gpt-4-turbo": { inputPerMillionTokens: 10, outputPerMillionTokens: 30 },
  "openai:gpt-4": { inputPerMillionTokens: 30, outputPerMillionTokens: 60 },
  "openai:gpt-3.5-turbo": { inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5 },
  // Legacy OpenAI realtime previews kept for existing CDRs.
  "openai:gpt-4o-realtime-preview": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 24,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
    inputImagePerMillionTokens: 5,
    cachedInputImagePerMillionTokens: 0.5,
  },
  "openai:gpt-4o-mini-realtime-preview": {
    inputPerMillionTokens: 0.6,
    cachedInputPerMillionTokens: 0.06,
    outputPerMillionTokens: 2.4,
    inputAudioPerMillionTokens: 10,
    cachedInputAudioPerMillionTokens: 0.3,
    outputAudioPerMillionTokens: 20,
  },
  // Current OpenAI realtime model prices from the public API pricing table.
  "openai:gpt-realtime": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 16,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
    inputImagePerMillionTokens: 5,
    cachedInputImagePerMillionTokens: 0.5,
  },
  "openai:gpt-realtime-2": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 24,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
    inputImagePerMillionTokens: 5,
    cachedInputImagePerMillionTokens: 0.5,
  },
  "openai:gpt-realtime-2.1": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 24,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
    inputImagePerMillionTokens: 5,
    cachedInputImagePerMillionTokens: 0.5,
  },
  "openai:gpt-realtime-mini": {
    inputPerMillionTokens: 0.6,
    cachedInputPerMillionTokens: 0.06,
    outputPerMillionTokens: 2.4,
    inputAudioPerMillionTokens: 10,
    cachedInputAudioPerMillionTokens: 0.3,
    outputAudioPerMillionTokens: 20,
    inputImagePerMillionTokens: 0.8,
    cachedInputImagePerMillionTokens: 0.08,
  },
  "openai:gpt-realtime-2.1-mini": {
    inputPerMillionTokens: 0.6,
    cachedInputPerMillionTokens: 0.06,
    outputPerMillionTokens: 2.4,
    inputAudioPerMillionTokens: 10,
    cachedInputAudioPerMillionTokens: 0.3,
    outputAudioPerMillionTokens: 20,
    inputImagePerMillionTokens: 0.8,
    cachedInputImagePerMillionTokens: 0.08,
  },
  "gemini:gemini-3.5-flash": { inputPerMillionTokens: 1.5, cachedInputPerMillionTokens: 0.15, outputPerMillionTokens: 9 },
  "gemini:gemini-3.1-pro-preview": { inputPerMillionTokens: 2, cachedInputPerMillionTokens: 0.2, outputPerMillionTokens: 12 },
  "gemini:gemini-3.1-flash-live-preview": {
    inputPerMillionTokens: 0.75,
    outputPerMillionTokens: 4.5,
    inputAudioPerMillionTokens: 3,
    outputAudioPerMillionTokens: 12,
    inputImagePerMillionTokens: 1,
  },
  "gemini:gemini-3.1-flash-lite": {
    inputPerMillionTokens: 0.25,
    cachedInputPerMillionTokens: 0.025,
    outputPerMillionTokens: 1.5,
    inputAudioPerMillionTokens: 0.5,
    cachedInputAudioPerMillionTokens: 0.05,
  },
  "gemini:gemini-3-flash-preview": {
    inputPerMillionTokens: 0.5,
    cachedInputPerMillionTokens: 0.05,
    outputPerMillionTokens: 3,
    inputAudioPerMillionTokens: 1,
    cachedInputAudioPerMillionTokens: 0.1,
  },
  "gemini:gemini-2.5-flash": {
    inputPerMillionTokens: 0.3,
    cachedInputPerMillionTokens: 0.03,
    outputPerMillionTokens: 2.5,
    inputAudioPerMillionTokens: 1,
    cachedInputAudioPerMillionTokens: 0.1,
  },
  "gemini:gemini-2.5-pro": { inputPerMillionTokens: 1.25, cachedInputPerMillionTokens: 0.125, outputPerMillionTokens: 10 },
  "gemini:gemini-2.5-flash-lite": {
    inputPerMillionTokens: 0.1,
    cachedInputPerMillionTokens: 0.01,
    outputPerMillionTokens: 0.4,
    inputAudioPerMillionTokens: 0.3,
    cachedInputAudioPerMillionTokens: 0.03,
  },
  "gemini:gemini-2.0-flash": {
    inputPerMillionTokens: 0.1,
    cachedInputPerMillionTokens: 0.025,
    outputPerMillionTokens: 0.4,
    inputAudioPerMillionTokens: 0.7,
    cachedInputAudioPerMillionTokens: 0.175,
  },
  "gemini:gemini-2.0-flash-001": {
    inputPerMillionTokens: 0.1,
    cachedInputPerMillionTokens: 0.025,
    outputPerMillionTokens: 0.4,
    inputAudioPerMillionTokens: 0.7,
    cachedInputAudioPerMillionTokens: 0.175,
  },
  "gemini:gemini-1.5-pro": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 5 },
  "gemini:gemini-2.5-flash-native-audio-latest": {
    inputPerMillionTokens: 0.5,
    outputPerMillionTokens: 2,
    inputAudioPerMillionTokens: 3,
    outputAudioPerMillionTokens: 12,
  },
  "gemini:gemini-2.5-flash-native-audio-preview-12-2025": {
    inputPerMillionTokens: 0.5,
    outputPerMillionTokens: 2,
    inputAudioPerMillionTokens: 3,
    outputAudioPerMillionTokens: 12,
  },
  // Gemini Live native audio realtime models
  "gemini:gemini-2.0-flash-live-001": {
    inputPerMillionTokens: 0.1,
    cachedInputPerMillionTokens: 0.025,
    outputPerMillionTokens: 0.4,
    inputAudioPerMillionTokens: 0.7,
    cachedInputAudioPerMillionTokens: 0.175,
    outputAudioPerMillionTokens: 1.5,
  },
  // Gemini 2.0 Flash Lite and 1.5 Flash LLM pipeline models
  "gemini:gemini-2.0-flash-lite": {
    inputPerMillionTokens: 0.075,
    outputPerMillionTokens: 0.3,
  },
  "gemini:gemini-1.5-flash": {
    inputPerMillionTokens: 0.075,
    cachedInputPerMillionTokens: 0.01875,
    outputPerMillionTokens: 0.3,
  },
  "sarvam:sarvam-30b": {
    inputPerMillionTokens: inrToUsd(2.5),
    cachedInputPerMillionTokens: inrToUsd(1.5),
    outputPerMillionTokens: inrToUsd(10),
  },
  "sarvam:sarvam-105b": {
    inputPerMillionTokens: inrToUsd(4),
    cachedInputPerMillionTokens: inrToUsd(2.5),
    outputPerMillionTokens: inrToUsd(16),
  },
};

const sarvamSttPerMinuteUsd = inrToUsd(30 / 60);
const sttRates: Record<string, SttRate> = {
  "openai:gpt-4o-transcribe": { perMinute: 0.006 },
  "openai:gpt-4o-mini-transcribe": { perMinute: 0.003 },
  "openai:gpt-realtime-whisper": { perMinute: 0.017 },
  "openai:gpt-realtime-translate": { perMinute: 0.034 },
  "openai:whisper-1": { perMinute: 0.006 },
  "sarvam:saaras:v3": { perMinute: sarvamSttPerMinuteUsd },
  "sarvam:saaras:v2.5": { perMinute: sarvamSttPerMinuteUsd },
  "sarvam:saarika:v2.5": { perMinute: sarvamSttPerMinuteUsd },
  "elevenlabs:scribe_v2_realtime": { perMinute: 0.39 / 60 },
  "elevenlabs:scribe_v2": { perMinute: 0.22 / 60 },
  "elevenlabs:scribe_v1": { perMinute: 0.22 / 60 },
  "deepgram:flux-general-en": { perMinute: 0.0065 },
  "deepgram:flux-general-multi": { perMinute: 0.0078 },
  "deepgram:nova-3": { perMinute: 0.0048 },
  "deepgram:nova-3-general": { perMinute: 0.0048 },
  "deepgram:nova-3-multilingual": { perMinute: 0.0058 },
  "deepgram:nova-3-medical": { perMinute: 0.0077 },
  "deepgram:nova-2-general": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-meeting": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-phonecall": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-finance": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-conversationalai": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-voicemail": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-video": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-medical": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-drivethru": { perMinute: 0.35 / 60 },
  "deepgram:nova-2-automotive": { perMinute: 0.35 / 60 },
  "deepgram:nova-general": { perMinute: 0.35 / 60 },
  "deepgram:nova-phonecall": { perMinute: 0.35 / 60 },
  "deepgram:nova-meeting": { perMinute: 0.35 / 60 },
  "deepgram:enhanced-general": { perMinute: 0.99 / 60 },
  "deepgram:enhanced-meeting": { perMinute: 0.99 / 60 },
  "deepgram:enhanced-phonecall": { perMinute: 0.99 / 60 },
  "deepgram:enhanced-finance": { perMinute: 0.99 / 60 },
  "deepgram:base": { perMinute: 0.87 / 60 },
  "deepgram:meeting": { perMinute: 0.87 / 60 },
  "deepgram:phonecall": { perMinute: 0.87 / 60 },
  "deepgram:finance": { perMinute: 0.87 / 60 },
  "deepgram:conversationalai": { perMinute: 0.87 / 60 },
  "deepgram:voicemail": { perMinute: 0.87 / 60 },
  "deepgram:video": { perMinute: 0.87 / 60 },
};

const ttsRates: Record<string, TtsRate> = {
  "openai:gpt-4o-mini-tts": {
    inputPerMillionTokens: 0.6,
    outputPerMillionTokens: 12,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "openai:tts-1": { perMillionCharacters: 15 },
  "openai:tts-1-hd": { perMillionCharacters: 30 },
  "gemini:gemini-3.1-flash-tts-preview": {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 20,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "gemini:gemini-2.5-flash-preview-tts": {
    inputPerMillionTokens: 0.5,
    outputPerMillionTokens: 10,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "gemini:gemini-2.5-flash-tts": {
    inputPerMillionTokens: 0.5,
    outputPerMillionTokens: 10,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "gemini:gemini-2.5-flash-lite-preview-tts": {
    inputPerMillionTokens: 0.3,
    outputPerMillionTokens: 10,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "gemini:gemini-2.5-pro-preview-tts": {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 20,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "gemini:gemini-2.5-pro-tts": {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 20,
    inputTokensPerCharacter: 0.25,
    audioTokensPerSecond: 25,
  },
  "sarvam:bulbul:v3": { perMillionCharacters: inrToUsd(3000) },
  "sarvam:bulbul:v2": { perMillionCharacters: inrToUsd(1500) },
  "elevenlabs:eleven_flash_v2_5": { perMillionCharacters: 50 },
  "elevenlabs:eleven_turbo_v2_5": { perMillionCharacters: 50 },
  "elevenlabs:eleven_multilingual_v2": { perMillionCharacters: 100 },
  "elevenlabs:eleven_v3": { perMillionCharacters: 100 },
};

let parsedOverrides: PricingOverrides | null | undefined;

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function canonicalPricingProvider(value: unknown) {
  const provider = normalized(value);
  if (provider === "google" || provider === "googleai" || provider.includes("gemini")) return "gemini";
  if (provider === "api.sarvam.ai" || provider.includes("sarvam")) return "sarvam";
  if (provider.includes("openai")) return "openai";
  if (provider.includes("deepgram")) return "deepgram";
  if (provider.includes("elevenlabs") || provider.includes("eleven_labs")) return "elevenlabs";
  return provider;
}

function cleanModelName(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.toLowerCase() !== "unknown" ? text : "";
}

function positive(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pricingKey(provider: string, model: string) {
  return `${canonicalPricingProvider(provider)}:${normalized(model).replace(/^models\//, "")}`;
}

function pricingOverrides() {
  if (parsedOverrides !== undefined) return parsedOverrides;
  const raw = process.env.MODEL_PRICING_OVERRIDES_JSON;
  if (!raw) {
    parsedOverrides = null;
    return parsedOverrides;
  }
  try {
    parsedOverrides = JSON.parse(raw) as PricingOverrides;
  } catch {
    parsedOverrides = null;
  }
  return parsedOverrides;
}

function lookupRate<T extends object>(
  rates: Record<string, T>,
  overrides: Record<string, Partial<T>> | undefined,
  provider: string,
  model: string,
) {
  const exact = pricingKey(provider, model);
  const exactBase = rates[exact];
  const exactOverride = overrides?.[exact];
  const merged = { ...(exactBase ?? {}), ...(exactOverride ?? {}) } as T;
  if (!Object.keys(merged).length) return null;

  return {
    rate: merged,
    key: exact,
    source: exactOverride ? "override" as const : "catalog" as const,
  };
}

function llmRate(provider: string, model: string) {
  return lookupRate(llmRates, pricingOverrides()?.llm, provider, model);
}

function sttRate(provider: string, model: string, language = "") {
  const useMultilingualNova3 =
    canonicalPricingProvider(provider) === "deepgram" &&
    ["nova-3", "nova-3-general"].includes(normalized(model)) &&
    normalized(language).includes("multi");
  return lookupRate(
    sttRates,
    pricingOverrides()?.stt,
    provider,
    useMultilingualNova3 ? "nova-3-multilingual" : model,
  );
}

function ttsRate(provider: string, model: string) {
  return lookupRate(ttsRates, pricingOverrides()?.tts, provider, model);
}

export type PublishedTtsPricing = {
  currency: "USD";
  source: "catalog" | "override";
  key: string;
  provider: string;
  model: string;
  unit: "per 1M characters" | "per minute" | "per 1M tokens";
  perMillionCharacters?: number;
  perThousandCharacters?: number;
  perMinute?: number;
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
};

export function publishedTtsPricingForModel(
  provider: string,
  model: string,
): PublishedTtsPricing | null {
  const normalizedProvider = canonicalPricingProvider(provider);
  const normalizedModel = normalized(model).replace(/^models\//, "");
  const lookup = ttsRate(normalizedProvider, normalizedModel);
  if (!lookup) return null;

  return {
    currency: "USD",
    source: lookup.source,
    key: lookup.key,
    provider: normalizedProvider,
    model: normalizedModel,
    unit: lookup.rate.perMillionCharacters
      ? "per 1M characters"
      : lookup.rate.perMinute
        ? "per minute"
        : "per 1M tokens",
    perMillionCharacters: lookup.rate.perMillionCharacters,
    perThousandCharacters: lookup.rate.perMillionCharacters === undefined
      ? undefined
      : lookup.rate.perMillionCharacters / 1000,
    perMinute: lookup.rate.perMinute,
    inputPerMillionTokens: lookup.rate.inputPerMillionTokens,
    outputPerMillionTokens: lookup.rate.outputPerMillionTokens,
  };
}

export function missingPricingForModel(
  component: PricingComponent,
  provider: string,
  model: string,
  language = "",
): MissingPricing | null {
  const normalizedProvider = canonicalPricingProvider(provider);
  const normalizedModel = normalized(model).replace(/^models\//, "");
  if (!normalizedProvider && !normalizedModel) return null;

  const lookup =
    component === "llm"
      ? llmRate(normalizedProvider, normalizedModel)
      : component === "stt"
        ? sttRate(normalizedProvider, normalizedModel, language)
        : ttsRate(normalizedProvider, normalizedModel);

  if (lookup) return null;
  return {
    component,
    provider: normalizedProvider,
    model: normalizedModel,
    key: pricingKey(normalizedProvider, normalizedModel),
    reason: "No exact catalog or explicit override pricing is configured for this provider/model.",
  };
}

export function missingPricingForStack(input: {
  pipelineMode?: string;
  realtimeProvider?: string;
  realtimeModel?: string;
  llmProvider?: string;
  llmModel?: string;
  sttProvider?: string;
  sttModel?: string;
  ttsProvider?: string;
  ttsModel?: string;
  language?: string;
}) {
  const candidates = input.pipelineMode === "realtime"
    ? [
        missingPricingForModel(
          "llm",
          input.realtimeProvider ?? "",
          input.realtimeModel ?? "",
        ),
      ]
    : [
        missingPricingForModel("llm", input.llmProvider ?? "", input.llmModel ?? ""),
        missingPricingForModel(
          "stt",
          input.sttProvider ?? "",
          input.sttModel ?? "",
          input.language ?? "",
        ),
        missingPricingForModel("tts", input.ttsProvider ?? "", input.ttsModel ?? ""),
      ];
  return candidates.filter((item): item is MissingPricing => Boolean(item));
}

function unpricedResult(component: PricingComponent, provider: string, model: string, reason?: string): CostResult {
  const missing = missingPricingForModel(component, provider, model) ?? {
    component,
    provider: canonicalPricingProvider(provider),
    model: normalized(model).replace(/^models\//, ""),
    key: pricingKey(provider, model),
    reason: reason ?? "No exact catalog or explicit override pricing is configured for this provider/model.",
  };
  return {
    cost: 0,
    missingPricing: missing,
    detail: {
      source: "unpriced" as const,
      key: missing.key,
      unit: "unpriced",
      provider: missing.provider,
      model: missing.model,
      note: missing.reason,
    },
  };
}

function notApplicableResult(component: PricingComponent): CostResult {
  return {
    cost: 0,
    detail: {
      source: "not_applicable" as const,
      key: `${component}:none`,
      unit: "not applicable",
    },
  };
}

function modelIdentity(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string) {
  return {
    provider: canonicalPricingProvider(cleanModelName(item.provider) || fallbackProvider),
    model: cleanModelName(item.model) || fallbackModel,
  };
}

function combinedPricingDetail(details: PricingDetail[], fallback: PricingDetail): PricingDetail {
  if (details.length === 0) return fallback;
  if (details.length === 1) return details[0];
  const sources = [...new Set(details.map((detail) => detail.source))];
  return {
    source: sources.length === 1 ? sources[0] : "mixed",
    key: "multiple",
    unit: "multi-model",
    models: details,
  };
}

function llmCostForUsage(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string): CostResult {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const inputTokens = positive(item.inputTokens);
  const outputTokens = positive(item.outputTokens);
  const inputAudioTokens = positive(item.inputAudioTokens);
  const inputCachedAudioTokens = Math.min(inputAudioTokens, positive(item.inputCachedAudioTokens));
  const outputAudioTokens = positive(item.outputAudioTokens);
  const inputImageTokens = positive(item.inputImageTokens);
  const inputCachedImageTokens = Math.min(inputImageTokens, positive(item.inputCachedImageTokens));
  const inputTextTokens = positive(item.inputTextTokens) || Math.max(0, inputTokens - inputAudioTokens - inputImageTokens);
  const inputCachedTokens = Math.min(inputTokens, positive(item.inputCachedTokens));
  const inputCachedTextTokens = Math.min(
    inputTextTokens,
    positive(item.inputCachedTextTokens) || Math.max(0, inputCachedTokens - inputCachedAudioTokens - inputCachedImageTokens),
  );
  const outputTextTokens = positive(item.outputTextTokens) || Math.max(0, outputTokens - outputAudioTokens);
  if (!provider && !model && inputTokens + outputTokens + inputAudioTokens + outputAudioTokens <= 0) {
    return notApplicableResult("llm");
  }

  const lookup = llmRate(provider, model);
  if (!lookup) {
    return unpricedResult("llm", provider, model);
  }

  const rate = lookup.rate;
  const textInputRate = rate.inputPerMillionTokens;
  const cachedTextInputRate = rate.cachedInputPerMillionTokens ?? textInputRate;
  const outputTextRate = rate.outputPerMillionTokens;
  const audioInputRate = rate.inputAudioPerMillionTokens ?? textInputRate;
  const cachedAudioInputRate = rate.cachedInputAudioPerMillionTokens ?? rate.cachedInputPerMillionTokens ?? audioInputRate;
  const audioOutputRate = rate.outputAudioPerMillionTokens ?? outputTextRate;
  const imageInputRate = rate.inputImagePerMillionTokens ?? textInputRate;
  const cachedImageInputRate = rate.cachedInputImagePerMillionTokens ?? rate.cachedInputPerMillionTokens ?? imageInputRate;

  const cost =
    (Math.max(0, inputTextTokens - inputCachedTextTokens) / 1_000_000) * textInputRate +
    (inputCachedTextTokens / 1_000_000) * cachedTextInputRate +
    (Math.max(0, inputAudioTokens - inputCachedAudioTokens) / 1_000_000) * audioInputRate +
    (inputCachedAudioTokens / 1_000_000) * cachedAudioInputRate +
    (Math.max(0, inputImageTokens - inputCachedImageTokens) / 1_000_000) * imageInputRate +
    (inputCachedImageTokens / 1_000_000) * cachedImageInputRate +
    (outputTextTokens / 1_000_000) * outputTextRate +
    (outputAudioTokens / 1_000_000) * audioOutputRate;

  return {
    cost,
    detail: {
      source: lookup.source,
      key: lookup.key,
      unit: "per 1M tokens",
      provider,
      model,
      inputPerMillionTokens: textInputRate,
      cachedInputPerMillionTokens: rate.cachedInputPerMillionTokens,
      outputPerMillionTokens: outputTextRate,
      inputAudioPerMillionTokens: rate.inputAudioPerMillionTokens,
      cachedInputAudioPerMillionTokens: rate.cachedInputAudioPerMillionTokens,
      outputAudioPerMillionTokens: rate.outputAudioPerMillionTokens,
      inputImagePerMillionTokens: rate.inputImagePerMillionTokens,
      cachedInputImagePerMillionTokens: rate.cachedInputImagePerMillionTokens,
      note: providerNote(provider),
    },
  };
}

function sttCostForUsage(
  item: ModelUsageItem,
  fallbackProvider: string,
  fallbackModel: string,
  language: string,
): CostResult {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const seconds = positive(item.audioDurationMs) / 1000;
  const inputTokens = positive(item.inputTokens);
  const outputTokens = positive(item.outputTokens);
  const estimated = item.estimated === true;
  const estimatedNote = estimated
    ? "STT duration was estimated from call duration because provider usage did not include audio duration."
    : undefined;
  if (!provider && !model) {
    return notApplicableResult("stt");
  }

  const lookup = sttRate(provider, model, language);
  if (!lookup) {
    const result = unpricedResult("stt", provider, model);
    result.detail.estimated = estimated;
    result.detail.note = detailNote(result.detail.note, estimatedNote);
    return result;
  }

  const rate = lookup.rate;
  const tokenCost = rate.inputPerMillionTokens || rate.outputPerMillionTokens
    ? (inputTokens / 1_000_000) * (rate.inputPerMillionTokens ?? 0) +
      (outputTokens / 1_000_000) * (rate.outputPerMillionTokens ?? 0)
    : 0;
  const minuteCost = rate.perMinute ? (seconds / 60) * rate.perMinute : 0;

  return {
    cost: tokenCost + minuteCost,
    detail: {
      source: lookup.source,
      key: lookup.key,
      unit: rate.perMinute ? "per minute" : "per 1M tokens",
      provider,
      model,
      perMinute: rate.perMinute,
      inputPerMillionTokens: rate.inputPerMillionTokens,
      outputPerMillionTokens: rate.outputPerMillionTokens,
      estimated,
      note: detailNote(estimatedNote, providerNote(provider), typeof item.note === "string" ? item.note : undefined),
    },
  };
}

function voiceMultiplier(rate: TtsRate, provider: string, voice: string) {
  const exact = rate.voiceMultipliers?.[voice];
  if (exact !== undefined) return exact;
  const normalizedVoice = normalized(voice);
  if (!normalizedVoice) return 1;
  const configured = rate.voiceMultipliers?.[normalizedVoice];
  if (configured !== undefined) return configured;
  return canonicalPricingProvider(provider) === "elevenlabs"
    ? elevenLabsVoiceRate(voice) ?? 1
    : 1;
}

function ttsCostForUsage(
  item: ModelUsageItem,
  fallbackProvider: string,
  fallbackModel: string,
  voice: string,
): CostResult {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const characters = positive(item.charactersCount);
  const audioSeconds = positive(item.audioDurationMs) / 1000;
  const inputTokens = positive(item.inputTokens);
  const outputTokens = positive(item.outputTokens);
  if (!provider && !model) {
    return notApplicableResult("tts");
  }

  const lookup = ttsRate(provider, model);
  if (!lookup) {
    return unpricedResult("tts", provider, model);
  }

  const rate = lookup.rate;
  const multiplier = voiceMultiplier(rate, provider, voice);
  const estimatedInputTokens = inputTokens || (rate.inputTokensPerCharacter ? characters * rate.inputTokensPerCharacter : 0);
  const estimatedOutputTokens = outputTokens || (rate.audioTokensPerSecond ? audioSeconds * rate.audioTokensPerSecond : 0);
  let cost = 0;

  if (rate.inputPerMillionTokens || rate.outputPerMillionTokens) {
    cost +=
      (estimatedInputTokens / 1_000_000) * (rate.inputPerMillionTokens ?? 0) +
      (estimatedOutputTokens / 1_000_000) * (rate.outputPerMillionTokens ?? 0);
  }
  if (rate.perMillionCharacters) {
    cost += (characters / 1_000_000) * rate.perMillionCharacters;
  }
  if (rate.perMillionAudioTokens) {
    const audioTokens = outputTokens || audioSeconds * (rate.audioTokensPerSecond ?? 25);
    cost += (audioTokens / 1_000_000) * rate.perMillionAudioTokens;
  }
  if (rate.perMinute) {
    cost += (audioSeconds / 60) * rate.perMinute;
  }

  return {
    cost: cost * multiplier,
    detail: {
      source: lookup.source,
      key: lookup.key,
      unit: rate.perMillionCharacters ? "per 1M characters" : rate.perMinute ? "per minute" : "per 1M tokens",
      provider,
      model,
      inputPerMillionTokens: rate.inputPerMillionTokens,
      outputPerMillionTokens: rate.outputPerMillionTokens,
      perMillionCharacters: rate.perMillionCharacters,
      perMillionAudioTokens: rate.perMillionAudioTokens,
      audioTokensPerSecond: rate.audioTokensPerSecond,
      perMinute: rate.perMinute,
      voiceMultiplier: multiplier === 1 ? undefined : multiplier,
      estimated: Boolean((!inputTokens && rate.inputTokensPerCharacter && characters) || (!outputTokens && rate.audioTokensPerSecond && audioSeconds)),
      note: (!inputTokens && rate.inputTokensPerCharacter && characters) || (!outputTokens && rate.audioTokensPerSecond && audioSeconds)
        ? [
            "Token usage was not fully reported, so missing TTS tokens were estimated from characters or audio duration.",
            providerNote(provider),
          ].filter(Boolean).join(" ")
        : providerNote(provider),
    },
  };
}

function usageItems(input: CallCostInput, type: string, aggregate: ModelUsageItem) {
  const items = (input.modelUsage ?? []).filter((item) => item.type === type);
  return items.length ? items : [aggregate];
}

export function calculateCallCost(input: CallCostInput) {
  if (input.isRealtime && input.modelUsage?.length) {
    input = {
      ...input,
      modelUsage: input.modelUsage.map((item) =>
        item.type === "llm_usage"
          ? { ...item, provider: input.llmProvider, model: input.llmModel }
          : item,
      ),
    };
  }
  const llmTokens = Math.max(0, input.llmTokens || input.llmInputTokens + input.llmOutputTokens);
  const inputTokens = Math.max(0, input.llmInputTokens || (input.llmOutputTokens ? 0 : llmTokens));
  const outputTokens = Math.max(0, input.llmOutputTokens);

  const llmResults = usageItems(input, "llm_usage", {
    type: "llm_usage",
    provider: input.llmProvider,
    model: input.llmModel,
    inputTokens,
    outputTokens,
  }).map((item) => llmCostForUsage(item, input.llmProvider, input.llmModel));
  const sttResults = usageItems(input, "stt_usage", {
    type: "stt_usage",
    provider: input.sttProvider,
    model: input.sttModel,
    audioDurationMs: Math.max(0, input.sttSeconds) * 1000,
    inputTokens: input.sttInputTokens ?? 0,
    outputTokens: input.sttOutputTokens ?? 0,
  }).map((item) => sttCostForUsage(item, input.sttProvider, input.sttModel, input.sttLanguage ?? ""));
  const ttsResults = usageItems(input, "tts_usage", {
    type: "tts_usage",
    provider: input.ttsProvider,
    model: input.ttsModel,
    charactersCount: input.ttsCharacters,
    audioDurationMs: Math.max(0, input.ttsAudioSeconds) * 1000,
    inputTokens: input.ttsInputTokens ?? 0,
    outputTokens: input.ttsOutputTokens ?? 0,
  }).map((item) => ttsCostForUsage(item, input.ttsProvider, input.ttsModel, input.ttsVoice));

  const llm = rounded(llmResults.reduce((sum, result) => sum + result.cost, 0));
  const stt = rounded(sttResults.reduce((sum, result) => sum + result.cost, 0));
  const tts = rounded(ttsResults.reduce((sum, result) => sum + result.cost, 0));
  const telephony = 0;
  const platformFeeInrPerCall = 0;
  const platformFee = 0;
  const providerCost = rounded(llm + stt + tts);
  const customerCost = providerCost;
  const allResults = [...llmResults, ...sttResults, ...ttsResults];
  const missingPricing = [...new Map(
    allResults
      .flatMap((result) => result.missingPricing ? [result.missingPricing] : [])
      .map((item) => [item.key, item]),
  ).values()];
  const pricingStatus: PricingStatus = missingPricing.length
    ? "unpriced"
    : allResults.some((result) => result.detail.estimated)
      ? "estimated"
      : "exact";

  return {
    calculationVersion: MODEL_PRICING_VERSION,
    pricingStatus,
    missingPricing,
    llm,
    stt,
    tts,
    telephony,
    providerCost,
    platformFee,
    platformFeeInrPerCall,
    customerCost,
    total: providerCost,
    currency: "USD",
    pricing: {
      llm: combinedPricingDetail(llmResults.map((result) => result.detail), {
        source: "not_applicable",
        key: "llm:none",
        unit: "not applicable",
      }),
      stt: combinedPricingDetail(sttResults.map((result) => result.detail), {
        source: "not_applicable",
        key: "stt:none",
        unit: "not applicable",
      }),
      tts: combinedPricingDetail(ttsResults.map((result) => result.detail), {
        source: "not_applicable",
        key: "tts:none",
        unit: "not applicable",
      }),
      telephony: {
        source: "account" as const,
        key: "telephony:not_billed",
        unit: "not billed",
        perMinute: 0,
        note: "Telephony is not included in provider-cost-only billing.",
      },
      platformFee: {
        source: "account" as const,
        key: "platform_fee:disabled",
        unit: "not billed",
        note: "Platform fee is disabled. Total equals selected provider cost.",
      },
    },
  };
}
