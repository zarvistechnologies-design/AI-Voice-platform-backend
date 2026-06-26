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

const sarvamTtsLanguageCodes = sarvamTtsLanguages.map((language) => language.code);
const sarvamTtsLanguageLabels = sarvamTtsLanguages.map((language) => language.label);

function sarvamVoiceProfile(
  value: string,
  label: string,
  gender: "male" | "female",
  model: "bulbul:v2" | "bulbul:v3",
): VoiceProfileOption {
  return {
    value,
    label,
    gender,
    model,
    languageCodes: sarvamTtsLanguageCodes,
    languageLabels: sarvamTtsLanguageLabels,
  };
}

export const sarvamV3VoiceProfiles = [
  sarvamVoiceProfile("shubh", "Shubh - Indian English support", "male", "bulbul:v3"),
  sarvamVoiceProfile("aditya", "Aditya - confident sales", "male", "bulbul:v3"),
  sarvamVoiceProfile("ritu", "Ritu - warm Hindi support", "female", "bulbul:v3"),
  sarvamVoiceProfile("priya", "Priya - Hindi customer support", "female", "bulbul:v3"),
  sarvamVoiceProfile("neha", "Neha - calm helpdesk", "female", "bulbul:v3"),
  sarvamVoiceProfile("rahul", "Rahul - clear service desk", "male", "bulbul:v3"),
  sarvamVoiceProfile("pooja", "Pooja - appointment desk", "female", "bulbul:v3"),
  sarvamVoiceProfile("rohan", "Rohan - professional support", "male", "bulbul:v3"),
  sarvamVoiceProfile("simran", "Simran - friendly care", "female", "bulbul:v3"),
  sarvamVoiceProfile("kavya", "Kavya - polished assistant", "female", "bulbul:v3"),
  sarvamVoiceProfile("amit", "Amit - business support", "male", "bulbul:v3"),
  sarvamVoiceProfile("dev", "Dev - concise operator", "male", "bulbul:v3"),
  sarvamVoiceProfile("ishita", "Ishita - soft support", "female", "bulbul:v3"),
  sarvamVoiceProfile("shreya", "Shreya - energetic support", "female", "bulbul:v3"),
  sarvamVoiceProfile("ratan", "Ratan - steady advisor", "male", "bulbul:v3"),
  sarvamVoiceProfile("varun", "Varun - sales outreach", "male", "bulbul:v3"),
  sarvamVoiceProfile("manan", "Manan - formal assistant", "male", "bulbul:v3"),
  sarvamVoiceProfile("sumit", "Sumit - Hindi operations", "male", "bulbul:v3"),
  sarvamVoiceProfile("roopa", "Roopa - care coordinator", "female", "bulbul:v3"),
  sarvamVoiceProfile("kabir", "Kabir - calm sales", "male", "bulbul:v3"),
  sarvamVoiceProfile("aayan", "Aayan - young support", "male", "bulbul:v3"),
  sarvamVoiceProfile("ashutosh", "Ashutosh - senior advisor", "male", "bulbul:v3"),
  sarvamVoiceProfile("advait", "Advait - neutral assistant", "male", "bulbul:v3"),
  sarvamVoiceProfile("anand", "Anand - service desk", "male", "bulbul:v3"),
  sarvamVoiceProfile("tanya", "Tanya - customer care", "female", "bulbul:v3"),
  sarvamVoiceProfile("tarun", "Tarun - quick support", "male", "bulbul:v3"),
  sarvamVoiceProfile("sunny", "Sunny - upbeat sales", "male", "bulbul:v3"),
  sarvamVoiceProfile("mani", "Mani - regional support", "male", "bulbul:v3"),
  sarvamVoiceProfile("gokul", "Gokul - regional care", "male", "bulbul:v3"),
  sarvamVoiceProfile("vijay", "Vijay - authoritative desk", "male", "bulbul:v3"),
  sarvamVoiceProfile("shruti", "Shruti - clear customer care", "female", "bulbul:v3"),
  sarvamVoiceProfile("suhani", "Suhani - friendly receptionist", "female", "bulbul:v3"),
  sarvamVoiceProfile("mohit", "Mohit - technical support", "male", "bulbul:v3"),
  sarvamVoiceProfile("kavitha", "Kavitha - South India support", "female", "bulbul:v3"),
  sarvamVoiceProfile("rehan", "Rehan - calm operator", "male", "bulbul:v3"),
  sarvamVoiceProfile("soham", "Soham - formal support", "male", "bulbul:v3"),
  sarvamVoiceProfile("rupali", "Rupali - patient helpdesk", "female", "bulbul:v3"),
];

export const sarvamV2VoiceProfiles = [
  sarvamVoiceProfile("anushka", "Anushka - classic support", "female", "bulbul:v2"),
  sarvamVoiceProfile("manisha", "Manisha - classic helpdesk", "female", "bulbul:v2"),
  sarvamVoiceProfile("vidya", "Vidya - classic assistant", "female", "bulbul:v2"),
  sarvamVoiceProfile("arya", "Arya - classic desk", "female", "bulbul:v2"),
  sarvamVoiceProfile("abhilash", "Abhilash - classic support", "male", "bulbul:v2"),
  sarvamVoiceProfile("karun", "Karun - classic operator", "male", "bulbul:v2"),
  sarvamVoiceProfile("hitesh", "Hitesh - classic advisor", "male", "bulbul:v2"),
];

export const sarvamV3Voices = sarvamV3VoiceProfiles.map((voice) => voice.value);
export const sarvamV2Voices = sarvamV2VoiceProfiles.map((voice) => voice.value);
const sarvamVoices = [...sarvamV3Voices, ...sarvamV2Voices];
const sarvamVoiceProfiles = [...sarvamV3VoiceProfiles, ...sarvamV2VoiceProfiles];

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
