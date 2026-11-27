import { AudioByteStream, shortuuid, tts, type APIConnectOptions } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

import { env } from "../config/env.js";

const MURF_TTS_SAMPLE_RATE = 24_000;
const MURF_TTS_CHANNELS = 1;

export const DEFAULT_MURF_TTS_MODEL = "falcon-2.1";
export const DEFAULT_MURF_VOICE = "Gordon";

export interface MurfTtsOptions {
  apiKey?: string;
  region?: string;
  model?: string;
  voice?: string;
  locale?: string;
  speed?: number;
  pitch?: number;
}

function murfStreamEndpoint(region?: string): string {
  const cleaned = (region || env.murfApiRegion || "global")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const subdomain = cleaned || "global";
  return `https://${subdomain}.api.murf.ai/v1/speech/stream`;
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
    const voiceId = this.options.voice?.trim() || DEFAULT_MURF_VOICE;
    const locale = this.options.locale?.trim() || undefined;

    if (!apiKey) {
      throw new Error("Murf AI API key is required. Set MURF_API_KEY in .env");
    }

    const payload: Record<string, unknown> = {
      text: this.inputText,
      voiceId,
      model,
      format: "PCM",
      sampleRate: MURF_TTS_SAMPLE_RATE,
      channelType: "MONO",
    };

    if (locale) {
      payload.locale = locale;
    }

    try {
      const response = await fetch(murfStreamEndpoint(this.options.region), {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
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
