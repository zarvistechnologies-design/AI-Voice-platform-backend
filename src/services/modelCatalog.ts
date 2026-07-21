import { env } from "../config/env.js";
import { rememberElevenLabsVoiceRate } from "./elevenLabsPricingService.js";

import { HttpError } from '../utils/httpError.js';

type ProviderCredentialHealth = {
  configured: boolean;
  configurationError?: string;
  verified: boolean;
};

let deepgramCredentialCache:
  | { expiresAt: number; promise: Promise<ProviderCredentialHealth> }
  | null = null;

async function deepgramCredentialHealth(): Promise<ProviderCredentialHealth> {
  if (!env.deepgramApiKey) return { configured: false, verified: true };

  const now = Date.now();
  if (deepgramCredentialCache && deepgramCredentialCache.expiresAt > now) {
    return deepgramCredentialCache.promise;
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${env.deepgramApiKey}` },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          configured: false,
          configurationError: "Invalid Deepgram API key",
          verified: true,
        };
      }

      return {
        configured: true,
        ...(response.ok ? {} : { configurationError: "Deepgram key could not be verified" }),
        verified: response.ok,
      };
    } catch {
      return {
        configured: true,
        configurationError: "Deepgram key could not be verified",
        verified: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  })();

  deepgramCredentialCache = { expiresAt: now + 30_000, promise };
  void promise.then((result) => {
    if (result.verified && deepgramCredentialCache?.promise === promise) {
      deepgramCredentialCache.expiresAt = Date.now() + 5 * 60_000;
    }
  });
  return promise;
}

const openaiVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];

const openaiRealtimeVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
  "cedar",
];

export const defaultOpenAIRealtimeModel = "gpt-realtime-2.1";

export const openaiRealtimeModels: readonly string[] = [
  defaultOpenAIRealtimeModel,
  "gpt-realtime-2.1-mini",
];

const openaiRealtimeModelAliases: Record<string, string> = {
  "gpt-realtime": defaultOpenAIRealtimeModel,
  "gpt-realtime-2": defaultOpenAIRealtimeModel,
  "gpt-realtime-mini": "gpt-realtime-2.1-mini",
  "gpt-4o-realtime": defaultOpenAIRealtimeModel,
  "gpt-4o-realtime-preview": defaultOpenAIRealtimeModel,
  "gpt-4o-mini-realtime": "gpt-realtime-2.1-mini",
  "gpt-4o-mini-realtime-preview": "gpt-realtime-2.1-mini",
};

export function normalizeOpenAIRealtimeModel(model: string) {
  const normalized = model.trim();
  if (!normalized) return defaultOpenAIRealtimeModel;
  const resolved = openaiRealtimeModelAliases[normalized] ?? normalized;
  return openaiRealtimeModels.includes(resolved) ? resolved : defaultOpenAIRealtimeModel;
}

const geminiVoices = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Pulcherrima",
  "Puck",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
];

export const defaultGeminiRealtimeModel = "gemini-3.1-flash-live-preview";
export const geminiRealtimeModels = [
  defaultGeminiRealtimeModel,
] as const;

const geminiRealtimeModelAliases: Record<string, string> = {
  "gemini-2.5-flash-native-audio-preview-12-2025": defaultGeminiRealtimeModel,
  "gemini-2.5-flash-native-audio-latest": defaultGeminiRealtimeModel,
  "gemini-2.5-flash-native-audio-preview-09-2025": defaultGeminiRealtimeModel,
  "gemini-2.5-flash-preview-native-audio-dialog": defaultGeminiRealtimeModel,
  "gemini-2.5-flash-exp-native-audio-thinking-dialog": defaultGeminiRealtimeModel,
  "gemini-live-2.5-flash-preview": defaultGeminiRealtimeModel,
  "gemini-live-2.5-flash-native-audio": defaultGeminiRealtimeModel,
  "gemini-2.0-flash-live-001": defaultGeminiRealtimeModel,
};

export const defaultGeminiLlmModel = "gemini-2.5-flash";
export const geminiLlmModels = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
] as const;

export const defaultGeminiTtsModel = "gemini-2.5-flash-preview-tts";
export const geminiTtsModels = [
  "gemini-2.5-flash-preview-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
] as const;

function normalizeModel(model: string, models: readonly string[], fallback: string) {
  return models.includes(model) ? model : fallback;
}

export function normalizeGeminiRealtimeModel(model: string) {
  const normalized = model.trim();
  if (!normalized) return defaultGeminiRealtimeModel;
  const resolved = geminiRealtimeModelAliases[normalized] ?? normalized;
  return normalizeModel(resolved, geminiRealtimeModels, defaultGeminiRealtimeModel);
}

export function normalizeGeminiLlmModel(model: string) {
  return normalizeModel(model, geminiLlmModels, defaultGeminiLlmModel);
}

export function normalizeGeminiTtsModel(model: string) {
  return normalizeModel(model, geminiTtsModels, defaultGeminiTtsModel);
}

const deepgramSttModels = [
  "flux-general-en",
  "flux-general-multi",
  "nova-3",
  "nova-3-general",
  "nova-3-medical",
  "nova-2-general",
  "nova-2-meeting",
  "nova-2-phonecall",
  "nova-2-finance",
  "nova-2-conversationalai",
  "nova-2-voicemail",
  "nova-2-video",
  "nova-2-medical",
  "nova-2-drivethru",
  "nova-2-automotive",
  "nova-general",
  "nova-phonecall",
  "nova-meeting",
  "enhanced-general",
  "enhanced-meeting",
  "enhanced-phonecall",
  "enhanced-finance",
  "base",
  "meeting",
  "phonecall",
  "finance",
  "conversationalai",
  "voicemail",
  "video",
] as const;

const deepgramAdditionalSttLanguages: VoiceLanguageOption[] = [
  { value: "English US", label: "English (US)", code: "en-US", sarvamStt: false, sarvamTts: false },
  { value: "English Australia", label: "English (Australia)", code: "en-AU", sarvamStt: false, sarvamTts: false },
  { value: "English New Zealand", label: "English (New Zealand)", code: "en-NZ", sarvamStt: false, sarvamTts: false },
  { value: "Spanish LATAM", label: "Spanish (Latin America)", code: "es-419", sarvamStt: false, sarvamTts: false },
  { value: "French Canada", label: "French (Canada)", code: "fr-CA", sarvamStt: false, sarvamTts: false },
  { value: "German", label: "German", code: "de-DE", sarvamStt: false, sarvamTts: false },
  { value: "Italian", label: "Italian", code: "it-IT", sarvamStt: false, sarvamTts: false },
  { value: "Portuguese Brazil", label: "Portuguese (Brazil)", code: "pt-BR", sarvamStt: false, sarvamTts: false },
  { value: "Portuguese Portugal", label: "Portuguese (Portugal)", code: "pt-PT", sarvamStt: false, sarvamTts: false },
  { value: "Dutch", label: "Dutch", code: "nl-NL", sarvamStt: false, sarvamTts: false },
  { value: "Chinese Mandarin", label: "Chinese (Mandarin)", code: "zh-CN", sarvamStt: false, sarvamTts: false },
  { value: "Chinese Taiwan", label: "Chinese (Taiwan)", code: "zh-TW", sarvamStt: false, sarvamTts: false },
  { value: "Japanese", label: "Japanese", code: "ja-JP", sarvamStt: false, sarvamTts: false },
  { value: "Korean", label: "Korean", code: "ko-KR", sarvamStt: false, sarvamTts: false },
  { value: "Russian", label: "Russian", code: "ru-RU", sarvamStt: false, sarvamTts: false },
  { value: "Turkish", label: "Turkish", code: "tr-TR", sarvamStt: false, sarvamTts: false },
  { value: "Indonesian", label: "Indonesian", code: "id-ID", sarvamStt: false, sarvamTts: false },
  { value: "Thai", label: "Thai", code: "th-TH", sarvamStt: false, sarvamTts: false },
  { value: "Polish", label: "Polish", code: "pl-PL", sarvamStt: false, sarvamTts: false },
  { value: "Ukrainian", label: "Ukrainian", code: "uk-UA", sarvamStt: false, sarvamTts: false },
  { value: "Swedish", label: "Swedish", code: "sv-SE", sarvamStt: false, sarvamTts: false },
  { value: "Norwegian", label: "Norwegian", code: "nb-NO", sarvamStt: false, sarvamTts: false },
  { value: "Danish", label: "Danish", code: "da-DK", sarvamStt: false, sarvamTts: false },
];

const elevenLabsVoices = [
  "9BWtsMINqrJLrRacOk9x",
  "CwhRBWXzGAHq8TQ4Fs17",
  "EXAVITQu4vr4xnSDxMaL",
  "FGY2WhTYpPnrIDTdsKH5",
  "IKne3meq5aSn9XLyUdCD",
  "JBFqnCBsd6RMkjVDRZzb",
  "N2lVS1w4EtoT3dr4eOWO",
  "SAz9YHcvj6GT2YYXdXww",
  "TX3LPaxmHKxFdv7VOQHJ",
  "XB0fDUnXU5powFXDhCwa",
  "Xb7hH8MSUJpSbSDYk0k2",
  "XrExE9yKIg1WjnnlVkGX",
  "bIHbv24MWmeRgasZH58o",
  "cgSgspJ2msm6clMCkdW9",
  "cjVigY5qzO86Huf0OWal",
  "iP95p4xoKVk53GoZ742B",
  "nPczCjzI2devNBz1zQrb",
  "onwK4e9ZLuTAKqWW03F9",
  "pFZP5JQG7iQjIQuC4Bku",
  "pNInz6obpgDQGcFmaJgB",
  "pqHfZKP75CvOlQylNhV4",
  "ErXwobaYiN019PkySvjV",
  "TxGEqnHWrfWFTfGW9XjX",
  "VR6AewLTigWG4xSOukaG",
];

export type VoiceLanguageOption = {
  value: string;
  label: string;
  code: string;
  sarvamStt: boolean;
  sarvamTts: boolean;
};

export const voiceLanguages: VoiceLanguageOption[] = [
  { value: "Multilingual", label: "Auto detect", code: "unknown", sarvamStt: true, sarvamTts: false },
  { value: "English", label: "English (India)", code: "en-IN", sarvamStt: true, sarvamTts: true },
  { value: "English UK", label: "English (UK)", code: "en-GB", sarvamStt: false, sarvamTts: false },
  { value: "Hindi", label: "Hindi", code: "hi-IN", sarvamStt: true, sarvamTts: true },
  { value: "Bengali", label: "Bengali", code: "bn-IN", sarvamStt: true, sarvamTts: true },
  { value: "Tamil", label: "Tamil", code: "ta-IN", sarvamStt: true, sarvamTts: true },
  { value: "Telugu", label: "Telugu", code: "te-IN", sarvamStt: true, sarvamTts: true },
  { value: "Kannada", label: "Kannada", code: "kn-IN", sarvamStt: true, sarvamTts: true },
  { value: "Malayalam", label: "Malayalam", code: "ml-IN", sarvamStt: true, sarvamTts: true },
  { value: "Marathi", label: "Marathi", code: "mr-IN", sarvamStt: true, sarvamTts: true },
  { value: "Gujarati", label: "Gujarati", code: "gu-IN", sarvamStt: true, sarvamTts: true },
  { value: "Punjabi", label: "Punjabi", code: "pa-IN", sarvamStt: true, sarvamTts: true },
  { value: "Odia", label: "Odia", code: "od-IN", sarvamStt: true, sarvamTts: true },
  { value: "Assamese", label: "Assamese", code: "as-IN", sarvamStt: true, sarvamTts: false },
  { value: "Urdu", label: "Urdu", code: "ur-IN", sarvamStt: true, sarvamTts: false },
  { value: "Nepali", label: "Nepali", code: "ne-IN", sarvamStt: true, sarvamTts: false },
  { value: "Konkani", label: "Konkani", code: "kok-IN", sarvamStt: true, sarvamTts: false },
  { value: "Kashmiri", label: "Kashmiri", code: "ks-IN", sarvamStt: true, sarvamTts: false },
  { value: "Sindhi", label: "Sindhi", code: "sd-IN", sarvamStt: true, sarvamTts: false },
  { value: "Sanskrit", label: "Sanskrit", code: "sa-IN", sarvamStt: true, sarvamTts: false },
  { value: "Santali", label: "Santali", code: "sat-IN", sarvamStt: true, sarvamTts: false },
  { value: "Manipuri", label: "Manipuri", code: "mni-IN", sarvamStt: true, sarvamTts: false },
  { value: "Bodo", label: "Bodo", code: "brx-IN", sarvamStt: true, sarvamTts: false },
  { value: "Maithili", label: "Maithili", code: "mai-IN", sarvamStt: true, sarvamTts: false },
  { value: "Dogri", label: "Dogri", code: "doi-IN", sarvamStt: true, sarvamTts: false },
  { value: "Spanish", label: "Spanish", code: "es-ES", sarvamStt: false, sarvamTts: false },
  { value: "French", label: "French", code: "fr-FR", sarvamStt: false, sarvamTts: false },
];

export const sarvamSttLanguages = voiceLanguages.filter((language) => language.sarvamStt);
export const sarvamTtsLanguages = voiceLanguages.filter((language) => language.sarvamTts);

const elevenLabsV25LanguageCodes = new Set([
  'en', 'hi', 'ta', 'es', 'fr',
]);
const elevenLabsV3LanguageCodes = new Set([
  'en', 'as', 'bn', 'gu', 'hi', 'kn', 'ml', 'mr', 'ne', 'pa', 'sd', 'ta', 'te', 'ur', 'es', 'fr',
]);
const elevenLabsV25Languages = voiceLanguages.filter((language) =>
  elevenLabsV25LanguageCodes.has(language.code.split('-')[0]?.toLowerCase()));
const elevenLabsV3Languages = voiceLanguages.filter((language) =>
  elevenLabsV3LanguageCodes.has(language.code.split('-')[0]?.toLowerCase()));
const elevenLabsLanguagesByModel = {
  eleven_flash_v2_5: elevenLabsV25Languages,
  eleven_turbo_v2_5: elevenLabsV25Languages,
  eleven_multilingual_v2: elevenLabsV25Languages,
  eleven_v3: elevenLabsV3Languages,
};

const deepgramLanguageAliases: Record<string, string> = {
  Multilingual: "multi",
  unknown: "multi",
  "hi-IN": "hi",
  "bn-IN": "bn",
  "gu-IN": "gu",
  "kn-IN": "kn",
  "mr-IN": "mr",
  "ta-IN": "ta",
  "te-IN": "te",
  "ur-IN": "ur",
  "es-ES": "es",
  "fr-FR": "fr",
  "de-DE": "de",
  "it-IT": "it",
  "pt-PT": "pt",
  "nl-NL": "nl",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "ru-RU": "ru",
  "tr-TR": "tr",
  "id-ID": "id",
  "th-TH": "th",
  "pl-PL": "pl",
  "uk-UA": "uk",
  "sv-SE": "sv",
  "nb-NO": "no",
  "da-DK": "da",
  Hindi: "hi",
  Bengali: "bn",
  Gujarati: "gu",
  Kannada: "kn",
  Marathi: "mr",
  Tamil: "ta",
  Telugu: "te",
  Urdu: "ur",
  Spanish: "es",
  French: "fr",
  German: "de",
  Italian: "it",
  Dutch: "nl",
  Japanese: "ja",
  Korean: "ko",
  Russian: "ru",
  Turkish: "tr",
  Indonesian: "id",
  Thai: "th",
  Polish: "pl",
  Ukrainian: "uk",
  Swedish: "sv",
  Norwegian: "no",
  Danish: "da",
};

const deepgramSupportedLanguageCodes = new Set([
  "multi",
  "da",
  "de",
  "en",
  "en-AU",
  "en-GB",
  "en-IN",
  "en-NZ",
  "en-US",
  "es",
  "es-419",
  "es-LATAM",
  "fr",
  "fr-CA",
  "bn",
  "gu",
  "hi",
  "hi-Latn",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "mr",
  "nl",
  "no",
  "pl",
  "pt",
  "pt-BR",
  "ru",
  "sv",
  "ta",
  "taq",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "zh",
  "zh-CN",
  "zh-TW",
]);

const deepgramMultilingualSafeModels = new Set([
  "flux-general-multi",
  "nova-3",
  "nova-3-general",
  "nova-2-general",
  "nova-general",
  "enhanced-general",
  "base",
  "whisper-tiny",
  "whisper-base",
  "whisper-small",
  "whisper-medium",
  "whisper-large",
]);

const deepgramFluxMultiLanguages = new Set(["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]);

const deepgramNova3Languages = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "tr",
  "zh",
  "hi",
  "bn",
  "gu",
  "kn",
  "mr",
  "ta",
  "te",
  "ur",
  "id",
]);

const deepgramNova2GeneralLanguages = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "tr",
  "zh",
  "hi",
  "id",
  "th",
  "pl",
  "uk",
  "sv",
  "no",
  "da",
]);

const deepgramEnhancedGeneralLanguages = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "zh",
  "hi",
  "ta",
]);

const deepgramBaseLanguages = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "zh",
  "hi",
]);

const deepgramWhisperModels = new Set([
  "whisper-tiny",
  "whisper-base",
  "whisper-small",
  "whisper-medium",
  "whisper-large",
]);

const deepgramEnglishOnlyModels = new Set([
  "flux-general-en",
  "nova-2-meeting",
  "nova-2-phonecall",
  "nova-2-finance",
  "nova-2-conversationalai",
  "nova-2-voicemail",
  "nova-2-video",
  "nova-2-medical",
  "nova-2-drivethru",
  "nova-2-automotive",
  "nova-phonecall",
  "nova-meeting",
  "enhanced-meeting",
  "enhanced-phonecall",
  "enhanced-finance",
  "meeting",
  "phonecall",
  "finance",
  "conversationalai",
  "voicemail",
  "video",
]);

export function deepgramLanguageCode(languageValue: string) {
  const normalized = languageValue.trim().toLowerCase();
  const matched = [...voiceLanguages, ...deepgramAdditionalSttLanguages].find((language) =>
    [language.value, language.label, language.code].some(
      (candidate) => candidate.toLowerCase() === normalized,
    ),
  );
  const rawCode = matched?.code ?? languageValue;
  const exact = deepgramLanguageAliases[rawCode] ?? deepgramLanguageAliases[matched?.value ?? ""];
  if (exact) return exact;
  if (deepgramSupportedLanguageCodes.has(rawCode)) return rawCode;
  const baseCode = rawCode.split("-")[0];
  return deepgramSupportedLanguageCodes.has(baseCode) ? baseCode : "multi";
}

export function deepgramModelForLanguage(model: string, languageValue: string) {
  const availableModels = deepgramModelsForLanguage([...deepgramSttModels], languageValue);
  if (availableModels.includes(model)) return model;
  return availableModels[0] ?? "nova-3";
}

export function deepgramModelsForLanguage(models: readonly string[], languageValue: string) {
  const language = deepgramLanguageCode(languageValue);
  const baseLanguage = language.split("-")[0];
  if (language === "multi") {
    return models.filter((model) => model === "flux-general-multi" || deepgramMultilingualSafeModels.has(model));
  }
  if (baseLanguage === "en") return [...models];

  return models.filter((model) => {
    if (model === "flux-general-multi") return deepgramFluxMultiLanguages.has(baseLanguage);
    if (model === "nova-3" || model === "nova-3-general") return deepgramNova3Languages.has(baseLanguage);
    if (model === "nova-2-general" || model === "nova-general") return deepgramNova2GeneralLanguages.has(baseLanguage);
    if (model === "enhanced-general") return deepgramEnhancedGeneralLanguages.has(baseLanguage);
    if (model === "base") return deepgramBaseLanguages.has(baseLanguage);
    if (deepgramWhisperModels.has(model)) return true;
    return !deepgramEnglishOnlyModels.has(model);
  });
}

function isDeepgramLanguageSupported(language: VoiceLanguageOption) {
  const exact = deepgramLanguageAliases[language.code] ?? deepgramLanguageAliases[language.value];
  if (exact) return deepgramSupportedLanguageCodes.has(exact);
  if (deepgramSupportedLanguageCodes.has(language.code)) return true;
  return deepgramSupportedLanguageCodes.has(language.code.split("-")[0]);
}

export const deepgramSttLanguages = [
  ...voiceLanguages,
  ...deepgramAdditionalSttLanguages,
].filter((language, index, languages) => {
  return (
    isDeepgramLanguageSupported(language) &&
    languages.findIndex((item) => item.value === language.value) === index
  );
});

const sarvamV3Voices = [
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "amelia",
  "sophia",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
];

const sarvamV2Voices = [
  "anushka",
  "manisha",
  "vidya",
  "arya",
  "abhilash",
  "karun",
  "hitesh",
];

const sarvamVoices = [...sarvamV3Voices, ...sarvamV2Voices];

const sarvamRecommendedVoicesByLanguageCode: Record<string, readonly string[]> = {
  "en-IN": ["ratan", "ishita"],
  "hi-IN": ["shubh", "ashutosh", "priya", "suhani"],
  "bn-IN": ["rehan", "roopa", "suhani"],
  "ta-IN": ["ratan", "rohan", "ishita", "ritu"],
  "te-IN": ["shubh", "ratan", "neha", "priya"],
  "kn-IN": ["shubh", "ratan", "neha", "ishita"],
  "ml-IN": ["shubh", "pooja"],
  "mr-IN": ["ratan", "priya", "ritu"],
  "gu-IN": ["ratan", "priya", "ritu"],
  "pa-IN": ["mani", "roopa", "suhani"],
  "od-IN": ["shubh", "ritu", "pooja"],
};

function voicesByLanguageFromRecommendations(
  recommendations: Record<string, readonly string[]>,
  languages: readonly VoiceLanguageOption[],
) {
  const voicesByLanguage = new Map<string, string[]>();
  for (const [code, voices] of Object.entries(recommendations)) {
    const language = languages.find((item) => item.code === code);
    for (const key of [code, language?.value, language?.label].filter(Boolean) as string[]) {
      voicesByLanguage.set(key, [...voices]);
    }
  }
  return Object.fromEntries(voicesByLanguage);
}

type ElevenLabsApiVoice = {
  voice_id?: string;
  name?: string;
  category?: string;
  description?: string;
  preview_url?: string;
  is_owner?: boolean;
  sharing?: {
    status?: string;
    rate?: number;
  } | null;
  rate?: number;
  labels?: Record<string, string>;
  verified_languages?: Array<{
    language?: string | null;
    locale?: string | null;
    accent?: string | null;
    model_id?: string;
    preview_url?: string;
  }> | null;
  public_owner_id?: string;
};

type ElevenLabsVoiceProfile = {
  value: string;
  label: string;
  gender?: "male" | "female";
  useCase?: string;
  tone?: string;
  note?: string;
  accent?: string;
  category?: string;
  qualityTier?: string;
  languageCodes?: string[];
  languageLabels?: string[];
  verifiedLanguageCodes?: string[];
  verifiedLanguageLabels?: string[];
  source?: string;
  rateMultiplier?: number;
};

type ElevenLabsVoiceResult = {
  voices: ElevenLabsApiVoice[];
  status: "success" | "invalid" | "transient";
};

let elevenLabsLastSuccessfulVoices: ElevenLabsApiVoice[] | undefined;
let elevenLabsLastSuccessfulIndianLibraryVoices: ElevenLabsApiVoice[] | undefined;
const elevenLabsInstalledVoiceIds = new Map<string, string>();

let elevenLabsVoiceCache:
  | {
      expiresAt: number;
      promise: Promise<ElevenLabsVoiceResult>;
    }
  | undefined;

let elevenLabsIndianLibraryCache:
  | {
      expiresAt: number;
      promise: Promise<ElevenLabsVoiceResult>;
    }
  | undefined;

function languageOptionsForElevenLabsMetadata(
  languageLabel: string | null | undefined = '',
  locale: string | null | undefined = '',
  accent: string | null | undefined = '',
) {
  const normalized = (languageLabel ?? '').trim().toLowerCase();
  const normalizedLocale = (locale ?? '').trim().toLowerCase();
  const normalizedAccent = (accent ?? '').trim().toLowerCase();
  const exactLocale = normalizedLocale
    ? voiceLanguages.filter((language) => language.code.toLowerCase() === normalizedLocale)
    : [];
  if (exactLocale.length) return exactLocale;
  if (!normalized) return [];

  const matches = voiceLanguages.filter((language) => {
    const baseCode = language.code.split('-')[0]?.toLowerCase();
    return (
      baseCode === normalized ||
      language.value.toLowerCase() === normalized ||
      language.label.toLowerCase() === normalized
    );
  });
  if (matches.length <= 1) return matches;
  if (normalizedAccent.includes('india')) {
    const indian = matches.filter((language) => language.code.toLowerCase() === 'en-in');
    if (indian.length) return indian;
  }
  if (normalizedAccent.includes('brit') || normalizedAccent.includes('england')) {
    const british = matches.filter((language) => language.code.toLowerCase() === 'en-gb');
    if (british.length) return british;
  }
  return matches;
}

function elevenLabsVoiceProfile(voice: ElevenLabsApiVoice): ElevenLabsVoiceProfile | undefined {
  const value = voice.voice_id?.trim();
  if (!value) return undefined;
  const rateMultiplier = voice.rate ?? voice.sharing?.rate;
  rememberElevenLabsVoiceRate(value, rateMultiplier);
  const labels = voice.labels ?? {};
  const verifiedLanguages = voice.verified_languages ?? [];
  const declaredPrimaryLanguages = languageOptionsForElevenLabsMetadata(
    labels.language,
    labels.locale,
    labels.accent,
  );
  const verifiedLanguageMatches = verifiedLanguages.flatMap((verified) =>
    languageOptionsForElevenLabsMetadata(
      verified.language,
      verified.locale,
      verified.accent ?? labels.accent,
    ));
  const uniqueVerifiedLanguages = verifiedLanguageMatches.filter(
    (language, index, all) => all.findIndex((item) => item.code === language.code) === index,
  );
  const verifiedLanguageCounts = new Map<string, number>();
  for (const language of verifiedLanguageMatches) {
    verifiedLanguageCounts.set(language.code, (verifiedLanguageCounts.get(language.code) ?? 0) + 1);
  }
  const dominantVerifiedLanguage = uniqueVerifiedLanguages
    .sort((left, right) =>
      (verifiedLanguageCounts.get(right.code) ?? 0) - (verifiedLanguageCounts.get(left.code) ?? 0))[0];
  // A multilingual model can make a voice speak other languages, but that does
  // not make those languages native to the voice. Expose only the declared or
  // dominant training language so the UI does not overstate accent quality.
  const languages = declaredPrimaryLanguages.length
    ? declaredPrimaryLanguages
    : dominantVerifiedLanguage
      ? [dominantVerifiedLanguage]
      : [];
  const rawGender = labels.gender?.toLowerCase();
  const gender = rawGender === 'male' || rawGender === 'female' ? rawGender : undefined;
  const verifiedAccent = verifiedLanguages.find((verified) => verified.accent)?.accent;
  const accent = labels.accent || verifiedAccent || undefined;

  return {
    value,
    label: voice.name?.trim() || value,
    ...(gender ? { gender } : {}),
    ...(labels.use_case ? { useCase: labels.use_case.replaceAll("_", " ") } : {}),
    ...(labels.descriptive ? { tone: labels.descriptive } : {}),
    ...(voice.description ? { note: voice.description } : {}),
    ...(accent ? { accent } : {}),
    ...(voice.category ? { category: voice.category } : {}),
    ...(voice.public_owner_id
      ? { qualityTier: 'Community voice', source: 'ElevenLabs Voice Library API' }
      : voice.sharing && voice.is_owner === false
        ? { qualityTier: 'ElevenLabs library' }
        : {}),
    ...(rateMultiplier !== undefined && Number.isFinite(rateMultiplier) && rateMultiplier > 0
      ? { rateMultiplier }
      : {}),
    ...(languages.length
      ? {
          languageCodes: languages.map((language) => language.code),
          languageLabels: languages.map((language) => language.label),
        }
      : {}),
    ...(uniqueVerifiedLanguages.length
      ? {
          verifiedLanguageCodes: uniqueVerifiedLanguages.map((language) => language.code),
          verifiedLanguageLabels: uniqueVerifiedLanguages.map((language) => language.label),
        }
      : {}),
  };
}

function sharedVoiceAsApiVoice(voice: Record<string, unknown>): ElevenLabsApiVoice | undefined {
  const voiceId = typeof voice.voice_id === 'string' ? voice.voice_id.trim() : '';
  const ownerId = typeof voice.public_owner_id === 'string' ? voice.public_owner_id.trim() : '';
  if (!voiceId || !ownerId) return undefined;
  const stringValue = (key: string) => typeof voice[key] === 'string' ? String(voice[key]) : undefined;
  return {
    voice_id: voiceId,
    public_owner_id: ownerId,
    name: stringValue('name'),
    category: stringValue('category'),
    description: stringValue('description'),
    preview_url: stringValue('preview_url'),
    is_owner: false,
    rate: typeof voice.rate === 'number' ? voice.rate : undefined,
    labels: {
      ...(stringValue('accent') ? { accent: stringValue('accent')! } : {}),
      ...(stringValue('gender') ? { gender: stringValue('gender')!.toLowerCase() } : {}),
      ...(stringValue('descriptive') ? { descriptive: stringValue('descriptive')! } : {}),
      ...(stringValue('use_case') ? { use_case: stringValue('use_case')! } : {}),
      ...(stringValue('language') ? { language: stringValue('language')! } : {}),
      ...(stringValue('locale') ? { locale: stringValue('locale')! } : {}),
    },
    verified_languages: Array.isArray(voice.verified_languages)
      ? voice.verified_languages as ElevenLabsApiVoice['verified_languages']
      : undefined,
  };
}

async function elevenLabsIndianLibraryVoices(): Promise<ElevenLabsVoiceResult> {
  if (!env.elevenLabsApiKey) return { voices: [], status: 'success' };
  if (elevenLabsIndianLibraryCache && elevenLabsIndianLibraryCache.expiresAt > Date.now()) {
    return elevenLabsIndianLibraryCache.promise;
  }

  const promise: Promise<ElevenLabsVoiceResult> = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const params = new URLSearchParams({
        page_size: '100',
        accent: 'indian',
        sort: 'cloned_by_count',
      });
      const response = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params}`, {
        headers: { 'xi-api-key': env.elevenLabsApiKey },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { voices: [], status: 'invalid' };
      }
      if (!response.ok) {
        return { voices: elevenLabsLastSuccessfulIndianLibraryVoices ?? [], status: 'transient' };
      }
      const payload = await response.json() as { voices?: Array<Record<string, unknown>> };
      const voices = (payload.voices ?? [])
        .map(sharedVoiceAsApiVoice)
        .filter((voice): voice is ElevenLabsApiVoice => Boolean(voice));
      elevenLabsLastSuccessfulIndianLibraryVoices = voices;
      return { voices, status: 'success' };
    } catch {
      return { voices: elevenLabsLastSuccessfulIndianLibraryVoices ?? [], status: 'transient' };
    } finally {
      clearTimeout(timeout);
    }
  })();

  elevenLabsIndianLibraryCache = { expiresAt: Date.now() + 5 * 60_000, promise };
  return promise;
}

function voicesByLanguageFromProfiles(profiles: readonly ElevenLabsVoiceProfile[]) {
  const voicesByLanguage = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const code of profile.languageCodes ?? []) {
      const language = voiceLanguages.find((item) => item.code === code);
      for (const key of [code, language?.value, language?.label].filter(Boolean) as string[]) {
        const voices = voicesByLanguage.get(key) ?? [];
        if (!voices.includes(profile.value)) voices.push(profile.value);
        voicesByLanguage.set(key, voices);
      }
    }
  }
  return Object.fromEntries(voicesByLanguage);
}

async function elevenLabsAccountVoices(): Promise<ElevenLabsVoiceResult> {
  if (!env.elevenLabsApiKey) return { voices: [], status: "success" };
  if (elevenLabsVoiceCache && elevenLabsVoiceCache.expiresAt > Date.now()) {
    return elevenLabsVoiceCache.promise;
  }

  const promise: Promise<ElevenLabsVoiceResult> = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(
        "https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=true",
        {
          headers: { "xi-api-key": env.elevenLabsApiKey },
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        elevenLabsLastSuccessfulVoices = undefined;
        return { voices: [], status: "invalid" };
      }
      if (!response.ok) {
        return {
          voices: elevenLabsLastSuccessfulVoices ?? [],
          status: "transient",
        };
      }
      const payload = (await response.json()) as { voices?: ElevenLabsApiVoice[] };
      const voices = Array.isArray(payload.voices) ? payload.voices : [];
      elevenLabsLastSuccessfulVoices = voices;
      return { voices, status: "success" };
    } catch {
      return {
        voices: elevenLabsLastSuccessfulVoices ?? [],
        status: "transient",
      };
    } finally {
      clearTimeout(timeout);
    }
  })();

  // Share one provider request across concurrent dashboard loads. Short-lived
  // failures are cached too, preventing a provider outage from creating a
  // request storm against both the provider and this API.
  elevenLabsVoiceCache = {
    expiresAt: Date.now() + 30_000,
    promise,
  };
  void promise.then((result) => {
    if (result.status !== "transient" && elevenLabsVoiceCache?.promise === promise) {
      elevenLabsVoiceCache.expiresAt = Date.now() + 5 * 60_000;
    }
  });
  return promise;
}

export async function ensureElevenLabsVoiceInstalled(voiceId: string) {
  const normalizedVoiceId = voiceId.trim();
  if (!normalizedVoiceId || !env.elevenLabsApiKey) return normalizedVoiceId;
  const remembered = elevenLabsInstalledVoiceIds.get(normalizedVoiceId);
  if (remembered) return remembered;

  const [account, library] = await Promise.all([
    elevenLabsAccountVoices(),
    elevenLabsIndianLibraryVoices(),
  ]);
  if (account.voices.some((voice) => voice.voice_id === normalizedVoiceId)) return normalizedVoiceId;
  const sharedVoice = library.voices.find((voice) => voice.voice_id === normalizedVoiceId);
  if (!sharedVoice?.public_owner_id) return normalizedVoiceId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(sharedVoice.public_owner_id)}/${encodeURIComponent(normalizedVoiceId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': env.elevenLabsApiKey,
        },
        body: JSON.stringify({
          new_name: (sharedVoice.name?.trim() || `Indian voice ${normalizedVoiceId.slice(0, 6)}`).slice(0, 100),
          bookmarked: true,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        'Could not add the selected Indian voice to your ElevenLabs account. Check the API key voice-library permissions and available voice slots.',
      );
    }
    const payload = await response.json() as { voice_id?: string };
    const installedVoiceId = payload.voice_id?.trim() || normalizedVoiceId;
    elevenLabsInstalledVoiceIds.set(normalizedVoiceId, installedVoiceId);
    elevenLabsVoiceCache = undefined;
    return installedVoiceId;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'ElevenLabs did not respond while adding the selected Indian voice. Please try again.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function elevenLabsLibraryPreview(voiceId: string) {
  const [account, library] = await Promise.all([
    elevenLabsAccountVoices(),
    elevenLabsIndianLibraryVoices(),
  ]);
  const voice = account.voices.find(
    (item) => item.voice_id === voiceId && item.sharing && item.is_owner === false,
  ) ?? library.voices.find((item) => item.voice_id === voiceId);
  if (!voice?.preview_url) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(voice.preview_url, {
      headers: { "xi-api-key": env.elevenLabsApiKey },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function elevenLabsLanguageCode(languageValue: string) {
  const normalized = languageValue.trim().toLowerCase();
  const language = voiceLanguages.find((item) =>
    [item.value, item.label, item.code].some((candidate) => candidate.toLowerCase() === normalized),
  );
  if (!language || language.code === "unknown") return undefined;
  const baseCode = language.code.split("-")[0]?.toLowerCase();
  return baseCode === "od" ? "or" : baseCode;
}

export const modelCatalog = {
  realtime: [
    {
      provider: "openai",
      label: "OpenAI Realtime",
      configured: Boolean(env.openaiApiKey),
      models: openaiRealtimeModels,
      voices: openaiRealtimeVoices,
    },
    {
      provider: "gemini",
      label: "Gemini Live",
      configured: Boolean(env.googleApiKey),
      models: geminiRealtimeModels,
      voices: geminiVoices,
    },
  ],
  llm: [
    {
      provider: "openai",
      label: "OpenAI",
      configured: Boolean(env.openaiApiKey),
      models: [
        "gpt-5.4",
        "gpt-5.3-chat-latest",
        "gpt-5.2",
        "gpt-5.2-chat-latest",
        "gpt-5.1",
        "gpt-5.1-chat-latest",
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
      ],
    },
    {
      provider: "gemini",
      label: "Google Gemini",
      configured: Boolean(env.googleApiKey),
      models: geminiLlmModels,
    },
    {
      provider: "sarvam",
      label: "Sarvam AI",
      configured: Boolean(env.sarvamApiKey),
      models: ["sarvam-30b", "sarvam-105b"],
    },
  ],
  stt: [
    {
      provider: "openai",
      label: "OpenAI Speech-to-text",
      configured: Boolean(env.openaiApiKey),
      models: [
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "gpt-realtime-whisper",
        "whisper-1",
      ],
    },
    {
      provider: "sarvam",
      label: "Sarvam Speech-to-text",
      configured: Boolean(env.sarvamApiKey),
      models: ["saaras:v3", "saaras:v2.5", "saarika:v2.5"],
      languages: sarvamSttLanguages,
    },
    {
      provider: "elevenlabs",
      label: "ElevenLabs Speech-to-text",
      configured: Boolean(env.elevenLabsApiKey),
      models: ["scribe_v2_realtime"],
      languages: voiceLanguages,
    },
    {
      provider: "deepgram",
      label: "Deepgram Speech-to-text",
      configured: Boolean(env.deepgramApiKey),
      models: deepgramSttModels,
      languages: deepgramSttLanguages,
    },
  ],
  tts: [
    {
      provider: "openai",
      label: "OpenAI Text-to-speech",
      configured: Boolean(env.openaiApiKey),
      models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
      voices: openaiVoices,
    },
    {
      provider: "gemini",
      label: "Gemini Text-to-speech",
      configured: Boolean(env.googleApiKey),
      models: geminiTtsModels,
      voices: geminiVoices,
    },
    {
      provider: "sarvam",
      label: "Sarvam Text-to-speech",
      configured: Boolean(env.sarvamApiKey),
      models: ["bulbul:v3", "bulbul:v2"],
      voices: sarvamVoices,
      languages: sarvamTtsLanguages,
      voicesByLanguage: voicesByLanguageFromRecommendations(
        sarvamRecommendedVoicesByLanguageCode,
        voiceLanguages,
      ),
      showAllVoicesWithLanguageOrder: true,
      voicesByModel: {
        "bulbul:v3": sarvamV3Voices,
        "bulbul:v2": sarvamV2Voices,
      },
    },
    {
      provider: "elevenlabs",
      label: "ElevenLabs Text-to-speech",
      configured: Boolean(env.elevenLabsApiKey),
      models: ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"],
      voices: elevenLabsVoices,
      languages: elevenLabsV3Languages,
      languagesByModel: elevenLabsLanguagesByModel,
    },
  ],
} as const;

async function loadConfiguredModelCatalog() {
  const [accountVoices, indianLibraryVoices, deepgramHealth] = await Promise.all([
    elevenLabsAccountVoices(),
    elevenLabsIndianLibraryVoices(),
    deepgramCredentialHealth(),
  ]);
  if (accountVoices.status === "transient" || !deepgramHealth.verified) {
    throw new Error("Provider metadata could not be refreshed");
  }
  const accountVoiceIds = new Set(accountVoices.voices.map((voice) => voice.voice_id));
  const availableVoices = [
    ...accountVoices.voices,
    ...indianLibraryVoices.voices.filter((voice) => !accountVoiceIds.has(voice.voice_id)),
  ];
  const voiceProfiles = availableVoices
    .map(elevenLabsVoiceProfile)
    .filter((profile): profile is ElevenLabsVoiceProfile => Boolean(profile));
  return {
    ...modelCatalog,
    stt: modelCatalog.stt.map((provider) =>
      provider.provider === "deepgram"
        ? {
            ...provider,
            configured: deepgramHealth.configured,
            ...(deepgramHealth.configurationError
              ? { configurationError: deepgramHealth.configurationError }
              : {}),
          }
        : provider.provider === "elevenlabs" && accountVoices.status === "invalid"
          ? {
              ...provider,
              configured: false,
              configurationError: "ElevenLabs credentials were rejected",
            }
          : provider,
    ),
    tts: modelCatalog.tts.map((provider) =>
      provider.provider === "elevenlabs"
        ? {
            ...provider,
            ...(accountVoices.status === "invalid"
              ? {
                  configured: false,
                  configurationError: "ElevenLabs credentials were rejected",
                }
              : {}),
            ...(voiceProfiles.length > 0
              ? {
                  voices: voiceProfiles.map((profile) => profile.value),
                  voiceProfiles,
                  voicesByLanguage: voicesByLanguageFromProfiles(voiceProfiles),
                  showAllVoicesWithLanguageOrder: true,
                }
              : {}),
          }
        : provider,
    ),
  };
}

type ConfiguredModelCatalog = Awaited<ReturnType<typeof loadConfiguredModelCatalog>>;

let configuredCatalogCache:
  | { value: ConfiguredModelCatalog; expiresAt: number }
  | undefined;
let configuredCatalogRefresh: Promise<ConfiguredModelCatalog> | undefined;
let configuredCatalogRetryAfter = 0;

function refreshConfiguredModelCatalog() {
  if (configuredCatalogRefresh) return configuredCatalogRefresh;
  configuredCatalogRefresh = loadConfiguredModelCatalog()
    .then((value) => {
      // Provider-specific helpers keep successful results for five minutes.
      // Rechecking this lightweight aggregate sooner lets a cold-start outage
      // recover without hiding account voices for the full provider TTL.
      configuredCatalogCache = { value, expiresAt: Date.now() + 30_000 };
      configuredCatalogRetryAfter = 0;
      return value;
    })
    .catch((error) => {
      // Preserve a last-known-good value and avoid retrying on every dashboard
      // request while a provider is temporarily unreachable.
      configuredCatalogRetryAfter = Date.now() + 30_000;
      throw error;
    })
    .finally(() => {
      configuredCatalogRefresh = undefined;
    });
  return configuredCatalogRefresh;
}

/**
 * Dashboard reads never wait on third-party provider metadata. A built-in or
 * last-known-good catalog is returned immediately while provider health and
 * account voices refresh in the background.
 */
export function configuredModelCatalogSnapshot(): {
  value: ConfiguredModelCatalog | typeof modelCatalog;
  ready: boolean;
} {
  const now = Date.now();
  if (
    (!configuredCatalogCache || configuredCatalogCache.expiresAt <= now)
    && configuredCatalogRetryAfter <= now
  ) {
    void refreshConfiguredModelCatalog().catch(() => undefined);
  }
  return {
    value: configuredCatalogCache?.value ?? modelCatalog,
    ready: Boolean(configuredCatalogCache),
  };
}

export async function configuredModelCatalog(): Promise<ConfiguredModelCatalog | typeof modelCatalog> {
  return configuredModelCatalogSnapshot().value;
}

export function configuredModelCatalogReady() {
  return Boolean(configuredCatalogCache);
}

export async function warmConfiguredModelCatalog() {
  await refreshConfiguredModelCatalog();
}

export type PipelineMode = "realtime" | "pipeline";
export type RealtimeProvider = "openai" | "gemini";
export type PipelineProvider = "openai" | "gemini" | "sarvam" | "elevenlabs";
export type SttProvider = "openai" | "sarvam" | "elevenlabs" | "deepgram";
