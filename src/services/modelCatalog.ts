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
      label: "Sarvam Text-to-speech",
      configured: Boolean(env.sarvamApiKey),
      models: ["bulbul:v3", "bulbul:v2"],
      voices: sarvamVoices,
      languages: sarvamTtsLanguages,
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
