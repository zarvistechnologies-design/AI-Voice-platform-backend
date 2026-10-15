import { AudioByteStream, shortuuid, tts, type APIConnectOptions } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

import { env } from "../config/env.js";

const AZURE_TTS_SAMPLE_RATE = 24_000;
const AZURE_TTS_CHANNELS = 1;

export interface AzureTtsOptions {
  apiKey?: string;
  region?: string;
  voice?: string;
  speed?: number;
  pitch?: number;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function voiceLanguage(voice: string): string {
  const parts = voice.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return "en-US";
}

function formatProsodyRate(speed?: number): string {
  if (!speed || speed === 1) return "+0%";
  const percent = Math.round((speed - 1) * 100);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

function formatProsodyPitch(pitch?: number): string {
  if (!pitch || pitch === 0) return "+0%";
  const percent = Math.round(pitch * 5);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

export class AzureChunkedStream extends tts.ChunkedStream {
  label = "azure.ChunkedStream";
  private readonly options: AzureTtsOptions;

  constructor(
    ttsInstance: AzureTTS,
    text: string,
    options: AzureTtsOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.options = options;
  }

  protected async run(): Promise<void> {
    const apiKey = this.options.apiKey || env.azureSpeechKey;
    const region = this.options.region || env.azureSpeechRegion || "eastus";
    const voice = this.options.voice || "en-US-JennyNeural";
    const lang = voiceLanguage(voice);
    const rate = formatProsodyRate(this.options.speed);
    const pitch = formatProsodyPitch(this.options.pitch);

    if (!apiKey) {
      throw new Error("Azure Speech key is required. Set AZURE_SPEECH_KEY in .env");
    }

    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>
  <voice name='${voice}'>
    <prosody rate='${rate}' pitch='${pitch}'>
      ${escapeXml(this.inputText)}
    </prosody>
  </voice>
</speak>`;

    try {
      const response = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": apiKey,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
            "User-Agent": "vozon-voice-agent",
          },
          body: ssml,
          signal: this.abortSignal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Azure Speech synthesis failed (${response.status}): ${errorText || response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("Azure Speech response did not include an audio stream");
      }

      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(
        AZURE_TTS_SAMPLE_RATE,
        AZURE_TTS_CHANNELS,
      );
      let lastFrame: AudioFrame | undefined;

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

      for await (const chunk of response.body as any) {
        emitFrames(audioByteStream.write(chunk));
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

export class AzureTTS extends tts.TTS {
  label = "azure.TTS";
  readonly options: AzureTtsOptions;

  constructor(options: AzureTtsOptions = {}) {
    super(AZURE_TTS_SAMPLE_RATE, AZURE_TTS_CHANNELS, { streaming: false });
    this.options = options;
  }

  get model(): string {
    return "azure-neural";
  }

  get provider(): string {
    return "Azure";
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new AzureChunkedStream(this, text, this.options, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error("Direct WebSocket streaming not supported on Azure REST TTS adapter. Use StreamAdapter.");
  }
}
