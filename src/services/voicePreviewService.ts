import type { AudioFrame } from "@livekit/rtc-node";
import { initializeLogger, loggerOptions } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { voiceLanguages } from "./modelCatalog.js";

type VoicePreviewProvider = "openai" | "gemini" | "sarvam";

type VoicePreviewInput = {
  mode: "realtime" | "pipeline";
  provider: VoicePreviewProvider;
  model: string;
  voice: string;
  language: string;
  text?: string;
  voiceSpeed?: number;
};

const previewText = "Hi, this is a quick voice preview. You can choose me for your agent.";

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

function cleanPreviewText(text: unknown) {
  if (typeof text !== "string") return previewText;
  return text.trim().replace(/\s+/g, " ").slice(0, 240) || previewText;
}

function sarvamLanguageCode(languageValue: string) {
  const normalized = languageValue.trim().toLowerCase();
  const language = voiceLanguages.find((item) =>
    [item.value, item.label, item.code].some((candidate) => candidate.toLowerCase() === normalized),
  );
  return language?.sarvamTts ? language.code : "en-IN";
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

function createPreviewTts(input: VoicePreviewInput) {
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
  if (!env.sarvamApiKey) throw new HttpError(503, "Sarvam voice preview is not configured.");
  return new sarvam.TTS({
    apiKey: env.sarvamApiKey,
    model: model === "bulbul:v2" ? "bulbul:v2" : "bulbul:v3",
    speaker: input.voice,
    targetLanguageCode: sarvamLanguageCode(input.language),
    pace: speed,
    streaming: false,
  });
}

export async function createVoicePreview(input: VoicePreviewInput) {
  ensureLiveKitLogger();
  const tts = createPreviewTts(input);
  tts.on("error", () => undefined);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const frames: AudioFrame[] = [];
  const stream = tts.synthesize(cleanPreviewText(input.text), undefined, controller.signal);

  try {
    for await (const event of stream) {
      frames.push(event.frame);
    }
    return framesToWav(frames);
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
