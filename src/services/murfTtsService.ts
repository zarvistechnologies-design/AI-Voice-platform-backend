import { AudioByteStream, shortuuid, tts, type APIConnectOptions } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

import { env } from "../config/env.js";

const MURF_TTS_SAMPLE_RATE = 24_000;
const MURF_TTS_CHANNELS = 1;

export const DEFAULT_MURF_TTS_MODEL = "falcon-2.1";
export const DEFAULT_MURF_VOICE = "en-US-gordon";

const MURF_LOCALE_ALIASES: Record<string, string> = {
  "en-gb": "en-UK",
  "ar-sa": "ar-XA",
  "ar-ae": "ar-XA",
};

const LEGACY_MURF_VOICE_ALIASES: Record<string, string> = {
  gordon: "en-US-gordon",
  natalie: "en-US-natalie",
  miles: "en-US-miles",
  hazel: "en-UK-hazel",
  isha: "en-IN-isha",
  marcus: "en-US-daniel",
  samantha: "en-US-alina",
  aaliyah: "en-US-luna",
  oliver: "en-UK-hugo",
  kavya: "en-IN-arohi",
  abhishek: "en-IN-samar",
  varun: "en-IN-nikhil",
  mateo: "es-MX-carlos",
  camila: "es-ES-elvira",
  chloe: "fr-FR-justine",
  leo: "de-DE-björn",
};

export interface MurfTtsOptions {
  apiKey?: string;
  region?: string;
  model?: string;
  voice?: string;
  locale?: string;
  speed?: number;
  pitch?: number;
}

export function murfStreamEndpoint(region?: string): string {
  const cleaned = (region || env.murfApiRegion || "global")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const subdomain = cleaned || "global";
  return `https://${subdomain}.api.murf.ai/v1/speech/stream`;
}

export function normalizeMurfVoiceId(voice?: string): string {
  const trimmed = voice?.trim() || "";
  if (!trimmed) return DEFAULT_MURF_VOICE;
  return LEGACY_MURF_VOICE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeMurfLocale(locale?: string): string | undefined {
  const trimmed = locale?.trim() || "";
  if (!trimmed) return undefined;
  return MURF_LOCALE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function stripLeadingWavHeader(chunk: Uint8Array): Uint8Array {
  if (
    chunk.byteLength >= 44
    && chunk[0] === 0x52 // R
    && chunk[1] === 0x49 // I
    && chunk[2] === 0x46 // F
    && chunk[3] === 0x46 // F
    && chunk[8] === 0x57 // W
    && chunk[9] === 0x41 // A
    && chunk[10] === 0x56 // V
    && chunk[11] === 0x45 // E
  ) {
    return chunk.subarray(44);
  }
  return chunk;
}

export function murfRateFromSpeed(speed?: number): number {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed === 1) return 0;
  return Math.max(-50, Math.min(50, Math.round((speed - 1) * 50)));
}

export function murfPitchFromSemitones(pitch?: number): number {
  if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch === 0) return 0;
  return Math.max(-50, Math.min(50, Math.round(pitch * 5)));
}

export async function fetchMurfSpeechStream(params: {
  apiKey: string;
  region?: string;
  text: string;
  voiceId: string;
  model: string;
  format: "PCM" | "WAV";
  sampleRate?: number;
  locale?: string;
  speed?: number;
  pitch?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  const endpoint = murfStreamEndpoint(params.region);
  const basePayload: Record<string, unknown> = {
    text: params.text,
    voiceId: normalizeMurfVoiceId(params.voiceId),
    model: params.model,
    format: params.format,
    sampleRate: params.sampleRate ?? MURF_TTS_SAMPLE_RATE,
    channelType: "MONO",
  };
  const normalizedLocale = normalizeMurfLocale(params.locale);
  const rate = murfRateFromSpeed(params.speed);
  const pitch = murfPitchFromSemitones(params.pitch);
  const hasOptionalOverrides = Boolean(normalizedLocale || rate !== 0 || pitch !== 0);
  const firstPayload: Record<string, unknown> = {
    ...basePayload,
    ...(normalizedLocale ? { locale: normalizedLocale } : {}),
    ...(rate !== 0 ? { rate } : {}),
    ...(pitch !== 0 ? { pitch } : {}),
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "api-key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(firstPayload),
    signal: params.signal,
  });

  if (response.ok || !hasOptionalOverrides || response.status !== 400) {
    return response;
  }

  // Some voices/locales reject cross-locale or prosody overrides (e.g. non-Murf
  // locale codes or fixed-prosody voices). Retry once with required fields so
  // Murf synthesizes cleanly using the voice's defaults.
  const errorText = await response.text().catch(() => "");
  if (!/locale|rate|pitch/i.test(errorText)) {
    return new Response(errorText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "api-key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(basePayload),
    signal: params.signal,
  });
}

export class MurfChunkedStream extends tts.ChunkedStream {
  label = "murf.ChunkedStream";
  private readonly options: MurfTtsOptions;

  constructor(
    ttsInstance: MurfTTS,
    text: string,
    options: MurfTtsOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.options = options;
  }

  protected async run(): Promise<void> {
    const apiKey = this.options.apiKey || env.murfApiKey;
    const model = this.options.model?.trim() || DEFAULT_MURF_TTS_MODEL;
    const voiceId = normalizeMurfVoiceId(this.options.voice);

    if (!apiKey) {
      throw new Error("Murf AI API key is required. Set MURF_API_KEY in .env");
    }

    try {
      const response = await fetchMurfSpeechStream({
        apiKey,
        region: this.options.region,
        text: this.inputText,
        voiceId,
        model,
        format: "PCM",
        sampleRate: MURF_TTS_SAMPLE_RATE,
        locale: this.options.locale,
        speed: this.options.speed,
        pitch: this.options.pitch,
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Murf AI synthesis failed (${response.status}): ${errorText || response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("Murf AI response did not include an audio stream");
      }

      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(
        MURF_TTS_SAMPLE_RATE,
        MURF_TTS_CHANNELS,
      );
      let lastFrame: AudioFrame | undefined;
      let isFirstChunk = true;

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      const emitFrames = (frames: AudioFrame[]) => {
        for (const frame of frames) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      };

      for await (const rawChunk of response.body as AsyncIterable<Uint8Array>) {
        const bytes = isFirstChunk ? stripLeadingWavHeader(rawChunk) : rawChunk;
        isFirstChunk = false;
        if (bytes.byteLength > 0) {
          emitFrames(audioByteStream.write(bytes));
        }
      }
      emitFrames(audioByteStream.flush());
      sendLastFrame(requestId, true);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      this.queue.close();
    }
  }
}

export class MurfTTS extends tts.TTS {
  label = "murf.TTS";
  readonly options: MurfTtsOptions;

  constructor(options: MurfTtsOptions = {}) {
    super(MURF_TTS_SAMPLE_RATE, MURF_TTS_CHANNELS, { streaming: false });
    this.options = options;
  }

  get model(): string {
    return this.options.model?.trim() || DEFAULT_MURF_TTS_MODEL;
  }

  get provider(): string {
    return "Murf";
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new MurfChunkedStream(this, text, this.options, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error("Direct WebSocket streaming not supported on Murf REST TTS adapter. Use StreamAdapter.");
  }
}
