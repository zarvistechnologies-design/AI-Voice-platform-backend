import type { AudioFrame } from "@livekit/rtc-node";
import { initializeLogger, loggerOptions } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as google from "@livekit/agents-plugin-google";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import {
  ensureElevenLabsVoiceAvailable,
  sarvamV2Voices,
  sarvamV3Voices,
  voiceLanguages,
} from "./modelCatalog.js";

type VoicePreviewProvider = "openai" | "gemini" | "sarvam" | "elevenlabs";

type VoicePreviewInput = {
  mode: "realtime" | "pipeline";
  provider: VoicePreviewProvider;
  model: string;
  voice: string;
  language: string;
  text?: string;
  voiceSpeed?: number;
};

const defaultPreviewText = "Hello, this is a short customer support voice sample.";
const previewCacheTtlMs = 30 * 60 * 1000;
const previewCacheLimit = 200;
const previewCache = new Map<string, { audio: Buffer; expiresAt: number }>();

const previewSamplesByLanguageCode: Record<string, string> = {
  "en-IN": "Hello, this is a short customer support voice sample.",
  "en-US": "Hello, this is a short customer support voice sample.",
  "en-GB": "Hello, this is a short customer support voice sample.",
  "en-AU": "Hello, this is a short customer support voice sample.",
  "hi-IN": "नमस्ते, यह ग्राहक सहायता की छोटी आवाज़ का नमूना है।",
  "bn-IN": "নমস্কার, এটি গ্রাহক সহায়তার একটি ছোট ভয়েস নমুনা।",
  "ta-IN": "வணக்கம், இது வாடிக்கையாளர் ஆதரவுக்கான சிறிய குரல் மாதிரி.",
  "te-IN": "నమస్కారం, ఇది కస్టమర్ సపోర్ట్ కోసం చిన్న వాయిస్ నమూనా.",
  "kn-IN": "ನಮಸ್ಕಾರ, ಇದು ಗ್ರಾಹಕ ಸಹಾಯಕ್ಕಾಗಿ ಚಿಕ್ಕ ಧ್ವನಿ ಮಾದರಿ.",
  "ml-IN": "നമസ്കാരം, ഇത് ഉപഭോക്തൃ സഹായത്തിനുള്ള ചെറിയ ശബ്ദ സാമ്പിളാണ്.",
  "mr-IN": "नमस्कार, हा ग्राहक सहाय्यासाठी छोटा आवाज नमुना आहे.",
  "gu-IN": "નમસ્તે, આ ગ્રાહક સહાય માટેનો નાનો અવાજ નમૂનો છે.",
  "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਇਹ ਗਾਹਕ ਸਹਾਇਤਾ ਲਈ ਛੋਟਾ ਆਵਾਜ਼ ਨਮੂਨਾ ਹੈ।",
  "od-IN": "ନମସ୍କାର, ଏହା ଗ୍ରାହକ ସହାୟତା ପାଇଁ ଏକ ଛୋଟ ଭଏସ୍ ନମୁନା।",
  "as-IN": "নমস্কাৰ, এইটো গ্ৰাহক সহায়তাৰ এটা সৰু কণ্ঠ নমুনা।",
  "ur-IN": "السلام علیکم، یہ کسٹمر سپورٹ کی مختصر آواز کا نمونہ ہے۔",
  "ne-IN": "नमस्ते, यो ग्राहक सहयोगको छोटो आवाज नमूना हो।",
  "es-ES": "Hola, esta es una breve muestra de voz para atención al cliente.",
  "fr-FR": "Bonjour, voici un court exemple de voix pour le service client.",
  "de-DE": "Hallo, dies ist eine kurze Sprachprobe für den Kundendienst.",
  "it-IT": "Ciao, questo è un breve campione vocale per l'assistenza clienti.",
  "pt-BR": "Olá, esta é uma breve amostra de voz para atendimento ao cliente.",
  "pt-PT": "Olá, esta é uma breve amostra de voz para apoio ao cliente.",
  "nl-NL": "Hallo, dit is een korte stemdemo voor klantenservice.",
  "ar-SA": "مرحباً، هذه عينة صوتية قصيرة لخدمة العملاء.",
  "zh-CN": "你好，这是一个简短的客服语音示例。",
  "ja-JP": "こんにちは。これはカスタマーサポート用の短い音声サンプルです。",
  "ko-KR": "안녕하세요, 고객 지원을 위한 짧은 음성 샘플입니다.",
  "ru-RU": "Здравствуйте, это короткий образец голоса для поддержки клиентов.",
  "tr-TR": "Merhaba, bu müşteri desteği için kısa bir ses örneğidir.",
  "id-ID": "Halo, ini adalah contoh suara singkat untuk dukungan pelanggan.",
  "ms-MY": "Helo, ini ialah sampel suara ringkas untuk sokongan pelanggan.",
  "th-TH": "สวัสดี นี่คือตัวอย่างเสียงสั้นสำหรับฝ่ายบริการลูกค้า",
  "vi-VN": "Xin chào, đây là mẫu giọng nói ngắn cho hỗ trợ khách hàng.",
  "fil-PH": "Kumusta, ito ay maikling sample ng boses para sa customer support.",
  "pl-PL": "Dzień dobry, to krótka próbka głosu dla obsługi klienta.",
  "uk-UA": "Вітаю, це короткий зразок голосу для служби підтримки.",
  "ro-RO": "Bună, acesta este un scurt exemplu de voce pentru suport clienți.",
  "el-GR": "Γεια σας, αυτό είναι ένα σύντομο δείγμα φωνής για υποστήριξη πελατών.",
  "he-IL": "שלום, זו דוגמת קול קצרה לשירות לקוחות.",
  "sv-SE": "Hej, det här är ett kort röstprov för kundsupport.",
  "nb-NO": "Hei, dette er en kort stemmeprøve for kundestøtte.",
  "da-DK": "Hej, dette er en kort stemmeprøve til kundesupport.",
  "fi-FI": "Hei, tämä on lyhyt ääninäyte asiakastukea varten.",
  "cs-CZ": "Dobrý den, toto je krátká ukázka hlasu pro zákaznickou podporu.",
  "hu-HU": "Üdvözlöm, ez egy rövid hangminta ügyfélszolgálathoz.",
  "sw-KE": "Hujambo, huu ni mfano mfupi wa sauti kwa huduma kwa wateja.",
};

function ensureLiveKitLogger() {
  if (!loggerOptions()) {
    initializeLogger({ pretty: false, level: env.nodeEnv === "production" ? "info" : "warn" });
  }
}

function clampSpeed(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(2, Math.max(0.5, value))
    : 1;
}

function findLanguage(languageValue: string) {
  const normalized = languageValue.trim().toLowerCase();
  return voiceLanguages.find((item) =>
    [item.value, item.label, item.code].some((candidate) => candidate.toLowerCase() === normalized),
  );
}

function previewLanguageCode(languageValue: string) {
  return findLanguage(languageValue)?.code ?? "en-IN";
}

function previewText(languageValue: string) {
  return previewSamplesByLanguageCode[previewLanguageCode(languageValue)] ?? defaultPreviewText;
}

function sarvamLanguageCode(languageValue: string) {
  const language = findLanguage(languageValue);
  return language?.sarvamTts ? language.code : "en-IN";
}

function languageCode(languageValue: string) {
  return findLanguage(languageValue)?.code;
}

function previewModel(input: VoicePreviewInput) {
  if (input.provider === "openai" && input.mode === "realtime") {
    return "gpt-4o-mini-tts";
  }
  if (input.provider === "gemini" && input.mode === "realtime") {
    return "gemini-2.5-flash-preview-tts";
  }
  return input.model;
}

function wavHeader(dataLength: number, sampleRate: number, channels: number) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function frameBuffer(frame: AudioFrame) {
  return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

function framesToWav(frames: AudioFrame[]) {
  const first = frames[0];
  if (!first) throw new HttpError(502, "Voice preview returned no audio.");
  const pcm = Buffer.concat(frames.map(frameBuffer));
  return Buffer.concat([wavHeader(pcm.byteLength, first.sampleRate, first.channels), pcm]);
}

function sarvamSpeaker(input: VoicePreviewInput) {
  const voices = input.model === "bulbul:v2" ? sarvamV2Voices : sarvamV3Voices;
  return voices.includes(input.voice) ? input.voice : voices[0] ?? "shubh";
}

function previewCacheKey(input: VoicePreviewInput) {
  return [
    input.mode,
    input.provider,
    previewModel(input),
    input.provider === "sarvam" ? sarvamSpeaker(input) : input.voice,
    previewLanguageCode(input.language),
    clampSpeed(input.voiceSpeed).toFixed(2),
  ].join(":");
}

function cachedPreview(key: string) {
  const cached = previewCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    previewCache.delete(key);
    return null;
  }
  return cached.audio;
}

function rememberPreview(key: string, audio: Buffer) {
  const now = Date.now();
  if (previewCache.size >= previewCacheLimit) {
    for (const [itemKey, item] of previewCache) {
      if (item.expiresAt <= now || previewCache.size >= previewCacheLimit) {
        previewCache.delete(itemKey);
      }
      if (previewCache.size < previewCacheLimit) break;
    }
  }
  previewCache.set(key, { audio, expiresAt: now + previewCacheTtlMs });
}

async function createPreviewTts(input: VoicePreviewInput) {
  const model = previewModel(input);
  const speed = clampSpeed(input.voiceSpeed);
  if (input.provider === "openai") {
    if (!env.openaiApiKey) throw new HttpError(503, "OpenAI voice preview is not configured.");
    return new openai.TTS({
      apiKey: env.openaiApiKey,
      model,
      voice: input.voice as openai.TTSVoices,
      speed,
      instructions: "Speak naturally and clearly for a short voice selection preview.",
    });
  }
  if (input.provider === "gemini") {
    if (!env.googleApiKey) throw new HttpError(503, "Gemini voice preview is not configured.");
    return new google.beta.TTS({
      apiKey: env.googleApiKey,
      model,
      voiceName: input.voice,
      instructions: "Speak naturally and clearly for a short voice selection preview.",
    });
  }
  if (input.provider === "elevenlabs") {
    if (!env.elevenLabsApiKey) throw new HttpError(503, "ElevenLabs voice preview is not configured.");
    const voiceId = await ensureElevenLabsVoiceAvailable(input.voice, input.voice);
    return new elevenlabs.TTS({
      apiKey: env.elevenLabsApiKey,
      model: model,
      voiceId,
      languageCode: languageCode(input.language),
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed,
      },
    });
  }
  if (!env.sarvamApiKey) throw new HttpError(503, "Sarvam voice preview is not configured.");
  return new sarvam.TTS({
    apiKey: env.sarvamApiKey,
    model: model === "bulbul:v2" ? "bulbul:v2" : "bulbul:v3",
    speaker: sarvamSpeaker(input),
    targetLanguageCode: sarvamLanguageCode(input.language),
    pace: speed,
    streaming: false,
  });
}

export async function createVoicePreview(input: VoicePreviewInput) {
  ensureLiveKitLogger();
  const cacheKey = previewCacheKey(input);
  const cached = cachedPreview(cacheKey);
  if (cached) return cached;

  const tts = await createPreviewTts(input);
  tts.on("error", () => undefined);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const frames: AudioFrame[] = [];
  const stream = tts.synthesize(previewText(input.language), undefined, controller.signal);

  try {
    for await (const event of stream) {
      frames.push(event.frame);
    }
    const audio = framesToWav(frames);
    rememberPreview(cacheKey, audio);
    return audio;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Voice preview timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    stream.close();
    await tts.close();
  }
}
