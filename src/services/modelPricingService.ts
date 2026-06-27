import { env } from "../config/env.js";

type PricingSource = "catalog" | "override" | "account" | "fallback";

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

export type CallCostInput = {
  llmProvider: string;
  llmModel: string;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmTokens: number;
  sttProvider: string;
  sttModel: string;
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
};

function inrToUsd(value: number) {
  const inrPerUsd = Number.isFinite(env.costRates.inrPerUsd) && env.costRates.inrPerUsd > 0
    ? env.costRates.inrPerUsd
    : 83;
  return value / inrPerUsd;
}

function providerNote(provider: string) {
  return normalized(provider) === "sarvam"
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
  "openai:gpt-5.3-chat-latest": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-5.2": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-5.2-chat-latest": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-5.1": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-5.1-chat-latest": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "openai:gpt-5": { inputPerMillionTokens: 1.25, cachedInputPerMillionTokens: 0.125, outputPerMillionTokens: 10 },
  "openai:gpt-5-mini": { inputPerMillionTokens: 0.25, cachedInputPerMillionTokens: 0.025, outputPerMillionTokens: 2 },
  "openai:gpt-5-nano": { inputPerMillionTokens: 0.05, cachedInputPerMillionTokens: 0.005, outputPerMillionTokens: 0.4 },
  "openai:gpt-4.1": { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
  "openai:gpt-4.1-mini": { inputPerMillionTokens: 0.4, outputPerMillionTokens: 1.6 },
  "openai:gpt-4.1-nano": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
  "openai:gpt-4o": { inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 },
  "openai:gpt-4o-mini": { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
  "openai:gpt-4-turbo": { inputPerMillionTokens: 10, outputPerMillionTokens: 30 },
  "openai:gpt-4": { inputPerMillionTokens: 30, outputPerMillionTokens: 60 },
  "openai:gpt-3.5-turbo": { inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5 },
  "openai:gpt-realtime": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 16,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
  },
  "openai:gpt-realtime-2": {
    inputPerMillionTokens: 4,
    cachedInputPerMillionTokens: 0.4,
    outputPerMillionTokens: 16,
    inputAudioPerMillionTokens: 32,
    cachedInputAudioPerMillionTokens: 0.4,
    outputAudioPerMillionTokens: 64,
  },
  "openai:gpt-realtime-mini": {
    inputPerMillionTokens: 0.6,
    cachedInputPerMillionTokens: 0.06,
    outputPerMillionTokens: 2.4,
    inputAudioPerMillionTokens: 10,
    cachedInputAudioPerMillionTokens: 0.3,
    outputAudioPerMillionTokens: 20,
  },
  "gemini:gemini-3.5-flash": { inputPerMillionTokens: 0.3, outputPerMillionTokens: 2.5 },
  "gemini:gemini-3.1-pro-preview": { inputPerMillionTokens: 2, outputPerMillionTokens: 12 },
  "gemini:gemini-3.1-flash-lite": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
  "gemini:gemini-3-flash-preview": { inputPerMillionTokens: 0.3, outputPerMillionTokens: 2.5 },
  "gemini:gemini-2.5-flash": { inputPerMillionTokens: 0.3, outputPerMillionTokens: 2.5 },
  "gemini:gemini-2.5-pro": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  "gemini:gemini-2.5-flash-lite": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
  "gemini:gemini-2.0-flash-001": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
  "gemini:gemini-1.5-pro": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 5 },
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
  "sarvam:*": { inputPerMillionTokens: env.costRates.llmPerMillionTokens, outputPerMillionTokens: env.costRates.llmPerMillionTokens },
};

const sarvamSttPerMinuteUsd = inrToUsd(30 / 60);
const sttRates: Record<string, SttRate> = {
  "openai:gpt-4o-transcribe": { perMinute: 0.006 },
  "openai:gpt-4o-mini-transcribe": { perMinute: 0.003 },
  "openai:gpt-realtime-whisper": { perMinute: 0.006 },
  "openai:whisper-1": { perMinute: 0.006 },
  "sarvam:saaras:v3": { perMinute: sarvamSttPerMinuteUsd },
  "sarvam:saaras:v2.5": { perMinute: sarvamSttPerMinuteUsd },
  "sarvam:saarika:v2.5": { perMinute: sarvamSttPerMinuteUsd },
  "sarvam:*": { perMinute: env.costRates.sttPerMinute },
  "elevenlabs:*": { perMinute: env.costRates.sttPerMinute },
};

const ttsRates: Record<string, TtsRate> = {
  "openai:gpt-4o-mini-tts": { perMillionCharacters: 15 },
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
  "sarvam:*": { perMillionCharacters: env.costRates.ttsPerMillionCharacters },
  "elevenlabs:*": { perMillionCharacters: env.costRates.ttsPerMillionCharacters },
};

let parsedOverrides: PricingOverrides | null | undefined;

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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
  return `${normalized(provider)}:${normalized(model)}`;
}

function wildcardKey(provider: string) {
  return `${normalized(provider)}:*`;
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
  const wildcard = wildcardKey(provider);
  const wildcardBase = rates[wildcard];
  const exactBase = rates[exact];
  const wildcardOverride = overrides?.[wildcard];
  const exactOverride = overrides?.[exact];
  const base = { ...(wildcardBase ?? {}), ...(exactBase ?? {}) };
  const override = { ...(wildcardOverride ?? {}), ...(exactOverride ?? {}) };
  const merged = { ...base, ...override } as T;
  if (!Object.keys(merged).length) return null;

  const key = exactOverride ? exact : wildcardOverride ? wildcard : exactBase ? exact : wildcard;
  const source: PricingSource = exactOverride || wildcardOverride
    ? "override"
    : exactBase ? "catalog" : "account";
  return { rate: merged, key, source };
}

function llmRate(provider: string, model: string) {
  return lookupRate(llmRates, pricingOverrides()?.llm, provider, model);
}

function sttRate(provider: string, model: string) {
  return lookupRate(sttRates, pricingOverrides()?.stt, provider, model);
}

function ttsRate(provider: string, model: string) {
  return lookupRate(ttsRates, pricingOverrides()?.tts, provider, model);
}

function modelIdentity(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string) {
  return {
    provider: cleanModelName(item.provider) || fallbackProvider,
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

function llmCostForUsage(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string) {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const lookup = llmRate(provider, model);
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

  if (!lookup) {
    return {
      cost: (Math.max(0, inputTokens + outputTokens) / 1_000_000) * env.costRates.llmPerMillionTokens,
      detail: {
        source: "fallback" as const,
        key: "COST_LLM_PER_MILLION_TOKENS",
        unit: "per 1M total tokens",
        provider,
        model,
        inputPerMillionTokens: env.costRates.llmPerMillionTokens,
        outputPerMillionTokens: env.costRates.llmPerMillionTokens,
        note: "No exact model rate was found. Add MODEL_PRICING_OVERRIDES_JSON for this model.",
      },
    };
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

function sttCostForUsage(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string) {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const lookup = sttRate(provider, model);
  const seconds = positive(item.audioDurationMs) / 1000;
  const inputTokens = positive(item.inputTokens);
  const outputTokens = positive(item.outputTokens);
  const estimated = item.estimated === true;
  const estimatedNote = estimated
    ? "STT duration was estimated from call duration because provider usage did not include audio duration."
    : undefined;

  if (!lookup) {
    return {
      cost: (seconds / 60) * env.costRates.sttPerMinute,
      detail: {
        source: "fallback" as const,
        key: "COST_STT_PER_MINUTE",
        unit: "per minute",
        provider,
        model,
        perMinute: env.costRates.sttPerMinute,
        estimated,
        note: detailNote(
          "No exact model rate was found. Add MODEL_PRICING_OVERRIDES_JSON for this model.",
          estimatedNote,
        ),
      },
    };
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

function voiceMultiplier(rate: TtsRate, voice: string) {
  const exact = rate.voiceMultipliers?.[voice];
  if (exact !== undefined) return exact;
  const normalizedVoice = normalized(voice);
  return normalizedVoice ? rate.voiceMultipliers?.[normalizedVoice] ?? 1 : 1;
}

function ttsCostForUsage(item: ModelUsageItem, fallbackProvider: string, fallbackModel: string, voice: string) {
  const { provider, model } = modelIdentity(item, fallbackProvider, fallbackModel);
  const lookup = ttsRate(provider, model);
  const characters = positive(item.charactersCount);
  const audioSeconds = positive(item.audioDurationMs) / 1000;
  const inputTokens = positive(item.inputTokens);
  const outputTokens = positive(item.outputTokens);

  if (!lookup) {
    return {
      cost: (characters / 1_000_000) * env.costRates.ttsPerMillionCharacters,
      detail: {
        source: "fallback" as const,
        key: "COST_TTS_PER_MILLION_CHARACTERS",
        unit: "per 1M characters",
        provider,
        model,
        perMillionCharacters: env.costRates.ttsPerMillionCharacters,
        note: "No exact model rate was found. Add MODEL_PRICING_OVERRIDES_JSON for this model.",
      },
    };
  }

  const rate = lookup.rate;
  const multiplier = voiceMultiplier(rate, voice);
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
  }).map((item) => sttCostForUsage(item, input.sttProvider, input.sttModel));
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
  const telephony = rounded((Math.max(0, input.durationSeconds) / 60) * env.costRates.telephonyPerMinute);

  return {
    llm,
    stt,
    tts,
    telephony,
    total: rounded(llm + stt + tts + telephony),
    currency: "USD",
    pricing: {
      llm: combinedPricingDetail(llmResults.map((result) => result.detail), {
        source: "fallback",
        key: "COST_LLM_PER_MILLION_TOKENS",
        unit: "per 1M total tokens",
      }),
      stt: combinedPricingDetail(sttResults.map((result) => result.detail), {
        source: "fallback",
        key: "COST_STT_PER_MINUTE",
        unit: "per minute",
      }),
      tts: combinedPricingDetail(ttsResults.map((result) => result.detail), {
        source: "fallback",
        key: "COST_TTS_PER_MILLION_CHARACTERS",
        unit: "per 1M characters",
      }),
      telephony: {
        source: "account" as const,
        key: "COST_TELEPHONY_PER_MINUTE",
        unit: "per minute",
        perMinute: env.costRates.telephonyPerMinute,
      },
    },
  };
}
