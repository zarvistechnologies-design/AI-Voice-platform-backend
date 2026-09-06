import {
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  type APIConnectOptions,
  normalizeLanguage,
  stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { type RawData, WebSocket } from "ws";

const sampleRate = 16_000;
const channels = 1;
const defaultBaseUrl = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

export type SarvamRealtimeStreamType = "fast" | "balanced" | "simulated";
export type SarvamRealtimeMode =
  | "transcribe"
  | "translate"
  | "verbatim"
  | "translit"
  | "codemix";

export type SarvamRealtimeSttOptions = {
  apiKey: string;
  languageCode: string;
  streamType?: SarvamRealtimeStreamType;
  mode?: SarvamRealtimeMode;
  threshold?: number;
  silenceDurationMs?: number;
  minSpeechDurationMs?: number;
  prompt?: string;
  returnTimestamps?: boolean;
  connectionTimeoutMs?: number;
  baseUrl?: string;
};

type ResolvedOptions = Required<
  Omit<SarvamRealtimeSttOptions, "prompt">
> & { prompt?: string };

type SarvamRealtimeMessage = {
  event?: string;
  session_id?: string;
  request_id?: string;
  text?: string;
  language?: string;
  language_confidence?: number;
  start_s?: number;
  end_s?: number;
  audio_duration_s?: number;
  code?: string | number;
  is_fatal?: boolean;
  message?: string;
};

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}

export function sarvamRealtimeLanguageCode(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized === "unknown" || normalized === "multi") return "auto";
  // The realtime endpoint uses the current BCP-47 code for Odia. Sarvam's
  // legacy streaming endpoint still uses od-IN.
  return normalized.toLowerCase() === "od-in" ? "or-IN" : normalized;
}

function resolveOptions(options: SarvamRealtimeSttOptions): ResolvedOptions {
  if (!options.apiKey.trim()) throw new Error("Sarvam API key is required");
  return {
    apiKey: options.apiKey,
    languageCode: sarvamRealtimeLanguageCode(options.languageCode),
    streamType: options.streamType ?? "fast",
    mode: options.mode ?? "transcribe",
    threshold: bounded(options.threshold, 0.3, 0, 1),
    silenceDurationMs: Math.round(bounded(options.silenceDurationMs, 250, 100, 2_000)),
    minSpeechDurationMs: Math.round(bounded(options.minSpeechDurationMs, 100, 50, 2_000)),
    prompt: options.prompt?.trim() || undefined,
    returnTimestamps: options.returnTimestamps ?? false,
    connectionTimeoutMs: Math.round(bounded(options.connectionTimeoutMs, 1_500, 500, 10_000)),
    baseUrl: options.baseUrl ?? defaultBaseUrl,
  };
}

export function buildSarvamRealtimeSttUrl(options: SarvamRealtimeSttOptions) {
  const resolved = resolveOptions(options);
  const url = new URL(resolved.baseUrl);
  url.searchParams.set("language_code", resolved.languageCode);
  url.searchParams.set("model", "saaras:v3-realtime");
  url.searchParams.set("stream_type", resolved.streamType);
  url.searchParams.set("mode", resolved.mode);
  url.searchParams.set("endpointing", "vad");
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(sampleRate));
  url.searchParams.set("threshold", String(resolved.threshold));
  url.searchParams.set("silence_duration_ms", String(resolved.silenceDurationMs));
  url.searchParams.set("min_speech_duration_ms", String(resolved.minSpeechDurationMs));
  url.searchParams.set("return_timestamps", String(resolved.returnTimestamps));
  if (resolved.prompt) url.searchParams.set("prompt", resolved.prompt);
  return url.toString();
}

function parseMessage(raw: RawData | string): SarvamRealtimeMessage {
  const text = typeof raw === "string" ? raw : raw.toString();
  return JSON.parse(text) as SarvamRealtimeMessage;
}

function closeError(code: number, reason: string) {
  const message = `Sarvam realtime STT closed (${code}${reason ? `: ${reason}` : ""})`;
  if (code === 1003 || code === 4000) {
    return new APIStatusError({
      message,
      options: { statusCode: 400, retryable: false, body: { closeCode: code, reason } },
    });
  }
  if (code === 1008) {
    return new APIStatusError({
      message,
      options: { statusCode: 408, retryable: true, body: { closeCode: code, reason } },
    });
  }
  return new APIConnectionError({ message, options: { retryable: code !== 1000 } });
}

function openSocket(options: ResolvedOptions, abortSignal?: AbortSignal) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(buildSarvamRealtimeSttUrl(options), {
      headers: { "api-subscription-key": options.apiKey },
    });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) reject(error);
      else resolve(socket);
    };
    const onOpen = () => finish();
    const onError = (error: Error) => finish(new APIConnectionError({
      message: `Sarvam realtime STT connection failed: ${error.message}`,
    }));
    const onClose = (code: number, reason: Buffer) => finish(closeError(code, reason.toString()));
    const onAbort = () => {
      socket.close();
      finish(new APIConnectionError({
        message: "Sarvam realtime STT connection aborted",
        options: { retryable: false },
      }));
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(new APIConnectionError({
        message: `Sarvam realtime STT connection timed out after ${options.connectionTimeoutMs}ms`,
      }));
    }, options.connectionTimeoutMs);

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Checks whether this Sarvam account can use the realtime beta endpoint.
 * Run during worker prewarm so an unsupported account never delays or loses
 * the caller's first utterance before the legacy stream is selected.
 */
export async function probeSarvamRealtimeStt(options: SarvamRealtimeSttOptions) {
  const resolved = resolveOptions(options);
  let socket: WebSocket | undefined;
  try {
    socket = await openSocket(resolved);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.removeListener("message", onMessage);
        socket?.removeListener("error", onFailure);
        socket?.removeListener("close", onFailure);
        resolve(available);
      };
      const onMessage = (raw: RawData) => {
        try {
          const event = parseMessage(raw).event;
          if (event === "session.begin" || event === "pong") finish(true);
          if (event === "error") finish(false);
        } catch {
          finish(false);
        }
      };
      const onFailure = () => finish(false);
      const timer = setTimeout(() => finish(false), resolved.connectionTimeoutMs);
      socket!.on("message", onMessage);
      socket!.once("error", onFailure);
      socket!.once("close", onFailure);
      // session.begin can arrive in the small gap between the WebSocket open
      // event and listener installation. A ping/pong is an explicit post-open
      // capability check and removes that race.
      socket!.send(JSON.stringify({ event: "ping" }));
    });
  } catch {
    return false;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event: "end" }));
      socket.close();
    }
  }
}

export class SarvamRealtimeSTT extends stt.STT {
  readonly label = "sarvam.RealtimeSTT";
  readonly options: ResolvedOptions;

  constructor(options: SarvamRealtimeSttOptions) {
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.options = resolveOptions(options);
  }

  override get model() {
    return "saaras:v3-realtime";
  }

  override get provider() {
    return "Sarvam AI";
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new APIConnectionError({
      message: "Sarvam realtime STT supports streaming recognition only",
      options: { retryable: false },
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }) {
    return new SarvamRealtimeSpeechStream(this, this.options, options?.connOptions);
  }
}

class SarvamRealtimeSpeechStream extends stt.SpeechStream {
  readonly label = "sarvam.RealtimeSpeechStream";
  readonly #options: ResolvedOptions;
  #speaking = false;
  #requestId = "";

  constructor(instance: SarvamRealtimeSTT, options: ResolvedOptions, connOptions?: APIConnectOptions) {
    super(instance, sampleRate, connOptions);
    this.#options = options;
  }

  protected async run() {
    const socket = await openSocket(this.#options, this.abortSignal);
    try {
      await this.#runSocket(socket);
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  async #runSocket(socket: WebSocket) {
    let intentionalClose = false;
    let settled = false;
    let sentAudioSeconds = 0;

    const session = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };

      socket.on("message", (raw) => {
        try {
          const message = parseMessage(raw);
          const event = message.event ?? "";
          if (event === "session.begin") {
            this.#requestId = message.session_id ?? message.request_id ?? this.#requestId;
            return;
          }
          if (event === "vad.speech_start") {
            this.#emitStart();
            return;
          }
          if (event === "transcript.partial") {
            if (!message.text) return;
            this.#emitStart();
            this.#put({
              type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
              requestId: message.request_id ?? this.#requestId,
              alternatives: [this.#alternative(message)],
            });
            return;
          }
          if (event === "transcript.final") {
            this.#emitStart();
            if (message.text) {
              this.#put({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                requestId: message.request_id ?? this.#requestId,
                alternatives: [this.#alternative(message)],
              });
            }
            this.#emitEnd();
            return;
          }
          if (event === "vad.speech_end") {
            // transcript.final follows this event. Emit END after FINAL so
            // LiveKit commits a complete turn instead of an empty one.
            return;
          }
          if (event === "session.end") {
            this.#put({
              type: stt.SpeechEventType.RECOGNITION_USAGE,
              requestId: this.#requestId,
              recognitionUsage: {
                audioDuration: message.audio_duration_s ?? sentAudioSeconds,
              },
            });
            intentionalClose = true;
            finish();
            return;
          }
          if (event === "error") {
            const error = new APIStatusError({
              message: `Sarvam realtime STT error${message.code ? ` ${message.code}` : ""}: ${message.message ?? "unknown error"}`,
              options: {
                statusCode: message.is_fatal ? 400 : 503,
                retryable: !message.is_fatal,
                body: message as Record<string, unknown>,
              },
            });
            if (message.is_fatal) finish(error);
          }
        } catch (error) {
          finish(new APIConnectionError({
            message: `Invalid Sarvam realtime STT response: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }
      });
      socket.once("error", (error) => finish(new APIConnectionError({
        message: `Sarvam realtime STT socket error: ${error.message}`,
      })));
      socket.once("close", (code, reason) => {
        if (intentionalClose || this.abortSignal.aborted || code === 1000) finish();
        else finish(closeError(code, reason.toString()));
      });
    });

    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: "ping" }));
      }
    }, 15_000);

    const sendAudio = async () => {
      const byteStream = new AudioByteStream(sampleRate, channels, sampleRate / 20);
      for await (const item of this.input) {
        if (this.abortSignal.aborted || socket.readyState !== WebSocket.OPEN) break;
        if (item === stt.SpeechStream.FLUSH_SENTINEL) continue;
        const frames = byteStream.write(item.data);
        for (const frame of frames) {
          sentAudioSeconds += frame.samplesPerChannel / frame.sampleRate;
          socket.send(JSON.stringify({
            event: "audio_input",
            audio: Buffer.from(
              frame.data.buffer,
              frame.data.byteOffset,
              frame.data.byteLength,
            ).toString("base64"),
          }));
        }
      }
      for (const frame of byteStream.flush()) {
        if (frame.samplesPerChannel === 0 || socket.readyState !== WebSocket.OPEN) continue;
        sentAudioSeconds += frame.samplesPerChannel / frame.sampleRate;
        socket.send(JSON.stringify({
          event: "audio_input",
          audio: Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          ).toString("base64"),
        }));
      }
      if (socket.readyState === WebSocket.OPEN) {
        intentionalClose = true;
        socket.send(JSON.stringify({ event: "end" }));
      }
    };

    const onAbort = () => {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN) socket.close();
    };
    this.abortSignal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.all([sendAudio(), session]);
    } finally {
      clearInterval(keepalive);
      this.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  #alternative(message: SarvamRealtimeMessage) {
    const language = message.language ?? (
      this.#options.languageCode === "auto" ? "unknown" : this.#options.languageCode
    );
    return {
      text: message.text ?? "",
      language: normalizeLanguage(language),
      startTime: message.start_s ?? 0,
      endTime: message.end_s ?? 0,
      confidence: message.language_confidence ?? 1,
    };
  }

  #emitStart() {
    if (this.#speaking) return;
    this.#speaking = true;
    this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  #emitEnd() {
    if (!this.#speaking) return;
    this.#speaking = false;
    this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
  }

  #put(event: stt.SpeechEvent) {
    if (!this.queue.closed) this.queue.put(event);
  }
}
