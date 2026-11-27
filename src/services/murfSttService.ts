import {
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  type APIConnectOptions,
  normalizeLanguage,
  stt,
} from "@livekit/agents";
import { type RawData, WebSocket } from "ws";

const MURF_STT_SAMPLE_RATE = 16_000;
const MURF_STT_CHANNELS = 1;

export const DEFAULT_MURF_STT_MODEL = "finch_indic_1.0";

export type MurfSttModel = "finch_indic_1.0" | "finch_global_1.0";

export type MurfSttOptions = {
  apiKey: string;
  model?: string;
  language?: string;
  bvc?: boolean;
  connectionTimeoutMs?: number;
};

type ResolvedMurfSttOptions = {
  apiKey: string;
  model: MurfSttModel;
  language?: string;
  bvc: boolean;
  connectionTimeoutMs: number;
};

type MurfSttRawEvent = {
  type?: string;
  event?: string;
  request_id?: string;
  audio_window_start?: number;
  audio_window_end?: number;
  transcript?: string;
  language?: string;
  languages?: string[];
  language_confidence?: number;
};

type MurfSttMessage = {
  type?: string;
  session_id?: string;
  request_id?: string;
  transcript?: string;
  language?: string | null;
  error_message?: string;
  message?: string;
  error_code?: number;
  rawEvent?: MurfSttRawEvent;
};

function resolveMurfSttModel(model?: string): MurfSttModel {
  const cleaned = (model ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (cleaned === "finch_global_1.0" || cleaned === "finch_global" || cleaned === "global") {
    return "finch_global_1.0";
  }
  return "finch_indic_1.0";
}

function murfSttBaseUrl(model: MurfSttModel): string {
  return model === "finch_global_1.0"
    ? "wss://us-east.api.murf.ai/v1/transcription/stream-input"
    : "wss://in.api.murf.ai/v1/transcription/stream-input";
}

function normalizeMurfSttLanguage(value?: string): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "auto" || trimmed === "unknown" || trimmed === "multi" || trimmed === "multilingual") {
    return undefined;
  }
  const base = trimmed.split("-")[0] ?? "";
  if (base === "od") return "or";
  return /^[a-z]{2}$/.test(base) ? base : undefined;
}

function resolveOptions(options: MurfSttOptions): ResolvedMurfSttOptions {
  if (!options.apiKey.trim()) throw new Error("Murf AI API key is required");
  return {
    apiKey: options.apiKey.trim(),
    model: resolveMurfSttModel(options.model),
    language: normalizeMurfSttLanguage(options.language),
    bvc: Boolean(options.bvc),
    connectionTimeoutMs: Math.min(10_000, Math.max(500, Math.round(options.connectionTimeoutMs ?? 3_000))),
  };
}

export function buildMurfSttUrl(options: MurfSttOptions): string {
  const resolved = resolveOptions(options);
  const url = new URL(murfSttBaseUrl(resolved.model));
  url.searchParams.set("api_key", resolved.apiKey);
  url.searchParams.set("model", resolved.model);
  if (resolved.language) {
    url.searchParams.set("language", resolved.language);
  }
  if (resolved.bvc) {
    url.searchParams.set("bvc", "true");
  }
  return url.toString();
}

function parseMessage(raw: RawData | string): MurfSttMessage {
  const text = typeof raw === "string" ? raw : raw.toString();
  return JSON.parse(text) as MurfSttMessage;
}

function closeError(code: number, reason: string) {
  const message = `Murf Finch STT closed (${code}${reason ? `: ${reason}` : ""})`;
  if (code === 1003 || code === 4000 || code === 4001 || code === 4003) {
    return new APIStatusError({
      message,
      options: { statusCode: 400, retryable: false, body: { closeCode: code, reason } },
    });
  }
  return new APIConnectionError({ message, options: { retryable: code !== 1000 && code !== 1005 } });
}

function openSocket(options: ResolvedMurfSttOptions, abortSignal?: AbortSignal) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(buildMurfSttUrl(options), {
      headers: { "api-key": options.apiKey },
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
    const onError = (error: Error) =>
      finish(new APIConnectionError({ message: `Murf Finch STT connection failed: ${error.message}` }));
    const onClose = (code: number, reason: Buffer) => finish(closeError(code, reason.toString()));
    const onAbort = () => {
      socket.close();
      finish(
        new APIConnectionError({
          message: "Murf Finch STT connection aborted",
          options: { retryable: false },
        }),
      );
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(
        new APIConnectionError({
          message: `Murf Finch STT connection timed out after ${options.connectionTimeoutMs}ms`,
        }),
      );
    }, options.connectionTimeoutMs);

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MurfRealtimeSTT extends stt.STT {
  readonly label = "murf.FinchSTT";
  readonly options: ResolvedMurfSttOptions;

  constructor(options: MurfSttOptions) {
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.options = resolveOptions(options);
  }

  override get model() {
    return this.options.model;
  }

  override get provider() {
    return "Murf";
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new APIConnectionError({
      message: "Murf Finch STT supports streaming recognition only",
      options: { retryable: false },
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }) {
    return new MurfRealtimeSpeechStream(this, this.options, options?.connOptions);
  }
}

class MurfRealtimeSpeechStream extends stt.SpeechStream {
  readonly label = "murf.FinchSpeechStream";
  readonly #options: ResolvedMurfSttOptions;
  #speaking = false;
  #requestId = "";

  constructor(instance: MurfRealtimeSTT, options: ResolvedMurfSttOptions, connOptions?: APIConnectOptions) {
    super(instance, MURF_STT_SAMPLE_RATE, connOptions);
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
    let usageEmitted = false;

    const emitUsageOnce = () => {
      if (usageEmitted || sentAudioSeconds <= 0) return;
      usageEmitted = true;
      this.#put({
        type: stt.SpeechEventType.RECOGNITION_USAGE,
        requestId: this.#requestId,
        recognitionUsage: {
          audioDuration: sentAudioSeconds,
        },
      });
    };

    const session = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        emitUsageOnce();
        error ? reject(error) : resolve();
      };

      socket.on("message", (raw) => {
        try {
          const message = parseMessage(raw);
          const type = (message.type ?? "").toLowerCase();

          if (type === "sessionstarted") {
            this.#requestId = message.session_id ?? message.request_id ?? this.#requestId;
            return;
          }

          if (type === "partial") {
            const rawEvent = message.rawEvent;
            if (rawEvent?.event === "StartOfTurn") {
              this.#emitStart();
              return;
            }
            const text = (message.transcript ?? rawEvent?.transcript ?? "").trim();
            if (!text) return;
            this.#emitStart();
            this.#put({
              type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
              requestId: rawEvent?.request_id ?? message.request_id ?? this.#requestId,
              alternatives: [this.#alternative(text, message)],
            });
            return;
          }

          if (type === "final") {
            const rawEvent = message.rawEvent;
            const text = (message.transcript ?? rawEvent?.transcript ?? "").trim();
            this.#emitStart();
            if (text) {
              this.#put({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                requestId: rawEvent?.request_id ?? message.request_id ?? this.#requestId,
                alternatives: [this.#alternative(text, message)],
              });
            }
            this.#emitEnd();
            return;
          }

          if (type === "error" || message.error_message) {
            const statusCode = typeof message.error_code === "number" ? message.error_code : 400;
            finish(
              new APIStatusError({
                message: `Murf Finch STT error: ${message.error_message ?? message.message ?? "unknown error"}`,
                options: {
                  statusCode,
                  retryable: statusCode >= 500,
                  body: message as Record<string, unknown>,
                },
              }),
            );
          }
        } catch (error) {
          finish(
            new APIConnectionError({
              message: `Invalid Murf Finch STT response: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        }
      });

      socket.once("error", (error) =>
        finish(new APIConnectionError({ message: `Murf Finch STT socket error: ${error.message}` })),
      );
      socket.once("close", (code, reason) => {
        if (intentionalClose || this.abortSignal.aborted || code === 1000 || code === 1005) {
          finish();
        } else {
          finish(closeError(code, reason.toString()));
        }
      });
    });

    // Send AudioConfig once before streaming PCM binary frames
    socket.send(
      JSON.stringify({
        type: "AudioConfig",
        codec: "pcm_s16le",
        sample_rate: MURF_STT_SAMPLE_RATE,
        channels: MURF_STT_CHANNELS,
      }),
    );

    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 15_000);

    const sendAudio = async () => {
      const byteStream = new AudioByteStream(
        MURF_STT_SAMPLE_RATE,
        MURF_STT_CHANNELS,
        MURF_STT_SAMPLE_RATE / 20,
      );
      const sendFrames = (frames: ReturnType<AudioByteStream["write"]>) => {
        for (const frame of frames) {
          if (frame.samplesPerChannel === 0 || socket.readyState !== WebSocket.OPEN) continue;
          sentAudioSeconds += frame.samplesPerChannel / frame.sampleRate;
          socket.send(
            Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          );
        }
      };

      for await (const item of this.input) {
        if (this.abortSignal.aborted || socket.readyState !== WebSocket.OPEN) break;
        if (item === stt.SpeechStream.FLUSH_SENTINEL) {
          sendFrames(byteStream.flush());
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "Finalize" }));
          }
          continue;
        }
        sendFrames(byteStream.write(item.data));
      }
      sendFrames(byteStream.flush());
      if (socket.readyState === WebSocket.OPEN) {
        intentionalClose = true;
        socket.close(1000);
      }
    };

    const onAbort = () => {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    };
    this.abortSignal.addEventListener("abort", onAbort, { once: true });

    try {
      await Promise.all([sendAudio(), session]);
    } finally {
      clearInterval(keepalive);
      emitUsageOnce();
      this.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  #alternative(text: string, message: MurfSttMessage) {
    const rawEvent = message.rawEvent;
    const language =
      rawEvent?.language
      ?? (typeof message.language === "string" ? message.language : undefined)
      ?? this.#options.language
      ?? "unknown";
    return {
      text,
      language: normalizeLanguage(language),
      startTime: rawEvent?.audio_window_start ?? 0,
      endTime: rawEvent?.audio_window_end ?? 0,
      confidence: rawEvent?.language_confidence ?? 1,
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
