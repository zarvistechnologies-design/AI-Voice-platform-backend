import { env } from "../config/env.js";

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

const elevenLabsVoices = [
  "bIHbv24MWmeRgasZH58o",
];

export type VoiceLanguageOption = {
  value: string;
  label: string;
  code: string;
  sarvamStt: boolean;
  sarvamTts: boolean;
};

export type VoiceProfileOption = {
  value: string;
  label: string;
  gender?: "male" | "female";
  model?: string;
  useCase?: string;
  tone?: string;
  qualityTier?: string;
  note?: string;
  languageCodes?: readonly string[];
  languageLabels?: readonly string[];
};

export const voiceLanguages: VoiceLanguageOption[] = [
  { value: "Multilingual", label: "Auto detect", code: "unknown", sarvamStt: true, sarvamTts: false },
  { value: "English", label: "English (India)", code: "en-IN", sarvamStt: true, sarvamTts: true },
  { value: "English US", label: "English (US)", code: "en-US", sarvamStt: false, sarvamTts: false },
  { value: "English UK", label: "English (UK)", code: "en-GB", sarvamStt: false, sarvamTts: false },
  { value: "English Australia", label: "English (Australia)", code: "en-AU", sarvamStt: false, sarvamTts: false },
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
  { value: "German", label: "German", code: "de-DE", sarvamStt: false, sarvamTts: false },
  { value: "Italian", label: "Italian", code: "it-IT", sarvamStt: false, sarvamTts: false },
  { value: "Portuguese Brazil", label: "Portuguese (Brazil)", code: "pt-BR", sarvamStt: false, sarvamTts: false },
  { value: "Portuguese Portugal", label: "Portuguese (Portugal)", code: "pt-PT", sarvamStt: false, sarvamTts: false },
  { value: "Dutch", label: "Dutch", code: "nl-NL", sarvamStt: false, sarvamTts: false },
  { value: "Arabic", label: "Arabic", code: "ar-SA", sarvamStt: false, sarvamTts: false },
  { value: "Chinese Mandarin", label: "Chinese (Mandarin)", code: "zh-CN", sarvamStt: false, sarvamTts: false },
  { value: "Japanese", label: "Japanese", code: "ja-JP", sarvamStt: false, sarvamTts: false },
  { value: "Korean", label: "Korean", code: "ko-KR", sarvamStt: false, sarvamTts: false },
  { value: "Russian", label: "Russian", code: "ru-RU", sarvamStt: false, sarvamTts: false },
  { value: "Turkish", label: "Turkish", code: "tr-TR", sarvamStt: false, sarvamTts: false },
  { value: "Indonesian", label: "Indonesian", code: "id-ID", sarvamStt: false, sarvamTts: false },
  { value: "Malay", label: "Malay", code: "ms-MY", sarvamStt: false, sarvamTts: false },
  { value: "Thai", label: "Thai", code: "th-TH", sarvamStt: false, sarvamTts: false },
  { value: "Vietnamese", label: "Vietnamese", code: "vi-VN", sarvamStt: false, sarvamTts: false },
  { value: "Filipino", label: "Filipino", code: "fil-PH", sarvamStt: false, sarvamTts: false },
  { value: "Polish", label: "Polish", code: "pl-PL", sarvamStt: false, sarvamTts: false },
  { value: "Ukrainian", label: "Ukrainian", code: "uk-UA", sarvamStt: false, sarvamTts: false },
  { value: "Romanian", label: "Romanian", code: "ro-RO", sarvamStt: false, sarvamTts: false },
  { value: "Greek", label: "Greek", code: "el-GR", sarvamStt: false, sarvamTts: false },
  { value: "Hebrew", label: "Hebrew", code: "he-IL", sarvamStt: false, sarvamTts: false },
  { value: "Swedish", label: "Swedish", code: "sv-SE", sarvamStt: false, sarvamTts: false },
  { value: "Norwegian", label: "Norwegian", code: "nb-NO", sarvamStt: false, sarvamTts: false },
  { value: "Danish", label: "Danish", code: "da-DK", sarvamStt: false, sarvamTts: false },
  { value: "Finnish", label: "Finnish", code: "fi-FI", sarvamStt: false, sarvamTts: false },
  { value: "Czech", label: "Czech", code: "cs-CZ", sarvamStt: false, sarvamTts: false },
  { value: "Hungarian", label: "Hungarian", code: "hu-HU", sarvamStt: false, sarvamTts: false },
  { value: "Swahili", label: "Swahili", code: "sw-KE", sarvamStt: false, sarvamTts: false },
];

export const sarvamSttLanguages = voiceLanguages.filter((language) => language.sarvamStt);
export const sarvamTtsLanguages = voiceLanguages.filter((language) => language.sarvamTts);

const sarvamLanguageLabelsByCode = new Map(
  sarvamTtsLanguages.map((language) => [language.code, language.label]),
);

function languageLabelsForCodes(codes: readonly string[]) {
  return codes.map((code) => sarvamLanguageLabelsByCode.get(code) ?? code);
}

type SarvamVoiceProfileMeta = {
  languageCodes?: readonly string[];
  useCase: string;
  tone: string;
  qualityTier?: string;
  note?: string;
};

function sarvamVoiceProfile(
  value: string,
  label: string,
  gender: "male" | "female",
  model: "bulbul:v2" | "bulbul:v3",
  meta: SarvamVoiceProfileMeta,
): VoiceProfileOption {
  const languageCodes = meta.languageCodes ?? [];
  return {
    value,
    label,
    gender,
    model,
    useCase: meta.useCase,
    tone: meta.tone,
    qualityTier: meta.qualityTier,
    note: meta.note,
    ...(languageCodes.length
      ? {
          languageCodes,
          languageLabels: languageLabelsForCodes(languageCodes),
        }
      : {}),
  };
}

export const sarvamV3VoiceProfiles = [
  sarvamVoiceProfile("shubh", "Shubh", "male", "bulbul:v3", {
    languageCodes: ["hi-IN", "te-IN", "kn-IN", "od-IN", "ml-IN"],
    useCase: "Customer support",
    tone: "neutral and reliable",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("aditya", "Aditya", "male", "bulbul:v3", {
    useCase: "Sales outreach",
    tone: "confident and direct",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("ritu", "Ritu", "female", "bulbul:v3", {
    languageCodes: ["ta-IN", "od-IN", "mr-IN", "gu-IN"],
    useCase: "Customer care",
    tone: "warm and reassuring",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("priya", "Priya", "female", "bulbul:v3", {
    languageCodes: ["hi-IN", "te-IN", "mr-IN", "gu-IN"],
    useCase: "Customer support",
    tone: "clear and warm",
    qualityTier: "Tier 1 - Excellent",
  }),
  sarvamVoiceProfile("neha", "Neha", "female", "bulbul:v3", {
    languageCodes: ["te-IN", "kn-IN"],
    useCase: "Helpdesk",
    tone: "calm and patient",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("rahul", "Rahul", "male", "bulbul:v3", {
    useCase: "Service desk",
    tone: "clear and practical",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("pooja", "Pooja", "female", "bulbul:v3", {
    languageCodes: ["od-IN", "ml-IN"],
    useCase: "Appointment desk",
    tone: "polite and helpful",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("rohan", "Rohan", "male", "bulbul:v3", {
    languageCodes: ["ta-IN"],
    useCase: "Business support",
    tone: "professional and steady",
  }),
  sarvamVoiceProfile("simran", "Simran", "female", "bulbul:v3", {
    useCase: "Care desk",
    tone: "friendly and expressive",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("kavya", "Kavya", "female", "bulbul:v3", {
    useCase: "Virtual assistant",
    tone: "polished and composed",
  }),
  sarvamVoiceProfile("amit", "Amit", "male", "bulbul:v3", {
    useCase: "Business support",
    tone: "crisp and formal",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("dev", "Dev", "male", "bulbul:v3", {
    useCase: "Operator",
    tone: "concise and neutral",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("ishita", "Ishita", "female", "bulbul:v3", {
    languageCodes: ["en-IN", "kn-IN", "ta-IN"],
    useCase: "Appointment booking",
    tone: "soft and clear",
    qualityTier: "Tier 1 - Excellent",
  }),
  sarvamVoiceProfile("shreya", "Shreya", "female", "bulbul:v3", {
    useCase: "Customer support",
    tone: "energetic and bright",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("ratan", "Ratan", "male", "bulbul:v3", {
    languageCodes: ["en-IN", "te-IN", "kn-IN", "ta-IN", "mr-IN", "gu-IN"],
    useCase: "Customer support",
    tone: "steady and dependable",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("varun", "Varun", "male", "bulbul:v3", {
    useCase: "Drama or suspense",
    tone: "deep and dramatic",
    qualityTier: "Tier 1 - Special use",
    note: "Not a neutral customer-support default.",
  }),
  sarvamVoiceProfile("manan", "Manan", "male", "bulbul:v3", {
    useCase: "Formal assistant",
    tone: "measured and official",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("sumit", "Sumit", "male", "bulbul:v3", {
    useCase: "Operations desk",
    tone: "practical and direct",
  }),
  sarvamVoiceProfile("roopa", "Roopa", "female", "bulbul:v3", {
    languageCodes: ["bn-IN", "pa-IN"],
    useCase: "Care coordinator",
    tone: "warm and patient",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("kabir", "Kabir", "male", "bulbul:v3", {
    useCase: "Sales qualification",
    tone: "calm and persuasive",
  }),
  sarvamVoiceProfile("aayan", "Aayan", "male", "bulbul:v3", {
    useCase: "Young support",
    tone: "fresh and approachable",
  }),
  sarvamVoiceProfile("ashutosh", "Ashutosh", "male", "bulbul:v3", {
    languageCodes: ["hi-IN"],
    useCase: "Senior advisory",
    tone: "calm and mature",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("advait", "Advait", "male", "bulbul:v3", {
    useCase: "Neutral assistant",
    tone: "balanced and simple",
  }),
  sarvamVoiceProfile("anand", "Anand", "male", "bulbul:v3", {
    useCase: "Service desk",
    tone: "friendly and grounded",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("tanya", "Tanya", "female", "bulbul:v3", {
    useCase: "Customer care",
    tone: "kind and conversational",
  }),
  sarvamVoiceProfile("tarun", "Tarun", "male", "bulbul:v3", {
    useCase: "Quick support",
    tone: "fast and clear",
  }),
  sarvamVoiceProfile("sunny", "Sunny", "male", "bulbul:v3", {
    useCase: "Sales outreach",
    tone: "upbeat and energetic",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("mani", "Mani", "male", "bulbul:v3", {
    languageCodes: ["pa-IN"],
    useCase: "Customer support",
    tone: "natural and reliable",
    qualityTier: "Tier 1 - Excellent",
  }),
  sarvamVoiceProfile("gokul", "Gokul", "male", "bulbul:v3", {
    useCase: "Regional care",
    tone: "grounded and patient",
  }),
  sarvamVoiceProfile("vijay", "Vijay", "male", "bulbul:v3", {
    useCase: "Authority desk",
    tone: "firm and confident",
  }),
  sarvamVoiceProfile("shruti", "Shruti", "female", "bulbul:v3", {
    useCase: "Customer care",
    tone: "clear and friendly",
  }),
  sarvamVoiceProfile("suhani", "Suhani", "female", "bulbul:v3", {
    languageCodes: ["hi-IN", "bn-IN", "pa-IN"],
    useCase: "Reception and appointments",
    tone: "sweet and friendly",
    qualityTier: "Tier 3 - Moderate",
  }),
  sarvamVoiceProfile("mohit", "Mohit", "male", "bulbul:v3", {
    useCase: "Technical support",
    tone: "focused and precise",
  }),
  sarvamVoiceProfile("kavitha", "Kavitha", "female", "bulbul:v3", {
    useCase: "Regional support",
    tone: "clear and local",
  }),
  sarvamVoiceProfile("rehan", "Rehan", "male", "bulbul:v3", {
    languageCodes: ["bn-IN"],
    useCase: "Support desk",
    tone: "calm and grounded",
    qualityTier: "Tier 2 - Good",
  }),
  sarvamVoiceProfile("soham", "Soham", "male", "bulbul:v3", {
    useCase: "Formal support",
    tone: "steady and professional",
  }),
  sarvamVoiceProfile("rupali", "Rupali", "female", "bulbul:v3", {
    useCase: "Patient helpdesk",
    tone: "gentle and attentive",
    qualityTier: "Tier 3 - Moderate",
  }),
];

export const sarvamV2VoiceProfiles = [
  sarvamVoiceProfile("anushka", "Anushka", "female", "bulbul:v2", {
    useCase: "Classic support",
    tone: "clear and professional",
  }),
  sarvamVoiceProfile("manisha", "Manisha", "female", "bulbul:v2", {
    useCase: "Classic helpdesk",
    tone: "warm and friendly",
  }),
  sarvamVoiceProfile("vidya", "Vidya", "female", "bulbul:v2", {
    useCase: "Classic assistant",
    tone: "articulate and precise",
  }),
  sarvamVoiceProfile("arya", "Arya", "female", "bulbul:v2", {
    useCase: "Classic desk",
    tone: "young and energetic",
  }),
  sarvamVoiceProfile("abhilash", "Abhilash", "male", "bulbul:v2", {
    useCase: "Classic support",
    tone: "deep and authoritative",
  }),
  sarvamVoiceProfile("karun", "Karun", "male", "bulbul:v2", {
    useCase: "Classic operator",
    tone: "natural and conversational",
  }),
  sarvamVoiceProfile("hitesh", "Hitesh", "male", "bulbul:v2", {
    useCase: "Classic advisor",
    tone: "professional and engaging",
  }),
];

export const sarvamV3Voices = sarvamV3VoiceProfiles.map((voice) => voice.value);
export const sarvamV2Voices = sarvamV2VoiceProfiles.map((voice) => voice.value);
const sarvamVoices = [...sarvamV3Voices, ...sarvamV2Voices];
const sarvamVoiceProfiles = [...sarvamV3VoiceProfiles, ...sarvamV2VoiceProfiles];

const sarvamRecommendedVoicesByLanguageCode: Record<string, readonly string[]> = {
  "en-IN": ["ratan", "ishita"],
  "hi-IN": ["shubh", "ashutosh", "priya", "suhani"],
  "te-IN": ["shubh", "ratan", "neha", "priya"],
  "kn-IN": ["shubh", "ratan", "neha", "ishita"],
  "bn-IN": ["rehan", "roopa", "suhani"],
  "ta-IN": ["ratan", "rohan", "ishita", "ritu"],
  "od-IN": ["shubh", "ritu", "pooja"],
  "ml-IN": ["shubh", "pooja"],
  "mr-IN": ["ratan", "priya", "ritu"],
  "pa-IN": ["mani", "roopa", "suhani"],
  "gu-IN": ["ratan", "priya", "ritu"],
};

function voicesByLanguageFromRecommendations(recommendations: Record<string, readonly string[]>) {
  const voicesByLanguage = new Map<string, string[]>();

  for (const [code, recommendedVoices] of Object.entries(recommendations)) {
    const language = voiceLanguages.find((item) => item.code === code);
    const keys = [code, language?.value, language?.label].filter(Boolean) as string[];
    for (const key of keys) {
      voicesByLanguage.set(key, [...recommendedVoices]);
    }
  }

  return Object.fromEntries(voicesByLanguage);
}

const sarvamVoicesByLanguage = voicesByLanguageFromRecommendations(
  sarvamRecommendedVoicesByLanguageCode,
);

export const modelCatalog = {
  realtime: [
    {
      provider: "openai",
      label: "OpenAI Realtime",
      configured: Boolean(env.openaiApiKey),
      models: ["gpt-realtime", "gpt-realtime-mini", "gpt-realtime-2"],
      voices: openaiRealtimeVoices,
    },
    {
      provider: "gemini",
      label: "Gemini Live",
      configured: Boolean(env.googleApiKey),
      models: [
        "gemini-live-2.5-flash-native-audio",
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-live-2.5-flash-preview-native-audio-09-2025",
        "gemini-live-2.5-flash-preview-native-audio",
      ],
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
      models: [
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-3.1-flash-lite",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash-001",
        "gemini-1.5-pro",
      ],
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
      models: ["scribe_v2_realtime", "scribe_v2", "scribe_v1"],
      languages: voiceLanguages,
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
      models: [
        "gemini-2.5-flash-preview-tts",
        "gemini-3.1-flash-tts-preview",
        "gemini-2.5-flash-tts",
        "gemini-2.5-flash-lite-preview-tts",
        "gemini-2.5-pro-tts",
      ],
      voices: geminiVoices,
    },
    {
      provider: "sarvam",
      label: "Sarvam Text-to-speech (India)",
      configured: Boolean(env.sarvamApiKey),
      models: ["bulbul:v3", "bulbul:v2"],
      voices: sarvamVoices,
      voiceProfiles: sarvamVoiceProfiles,
      languages: sarvamTtsLanguages,
      voicesByLanguage: sarvamVoicesByLanguage,
      voicesByModel: {
        "bulbul:v3": sarvamV3Voices,
        "bulbul:v2": sarvamV2Voices,
      },
    },
    {
      provider: "elevenlabs",
      label: "ElevenLabs Text-to-speech",
      configured: Boolean(env.elevenLabsApiKey),
      models: ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
      voices: elevenLabsVoices,
      languages: voiceLanguages.filter((language) => language.code !== "unknown"),
    },
  ],
} as const;

export type PipelineMode = "realtime" | "pipeline";
export type RealtimeProvider = "openai" | "gemini";
export type PipelineProvider = "openai" | "gemini" | "sarvam" | "elevenlabs";
export type SttProvider = "openai" | "sarvam" | "elevenlabs";
