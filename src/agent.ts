import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { ParticipantKind, RoomEvent, type RemoteParticipant } from "@livekit/rtc-node";
import { fileURLToPath } from "node:url";

import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { recordAgentLatency } from "./services/latencyService.js";
import { voiceLanguages } from "./services/modelCatalog.js";
import {
  appendTranscriptItem,
  completeCall,
  failCall,
  markCallActive,
  recordCallLatency,
  recordCallUsage,
} from "./services/callRecordService.js";
import { createCalendlySchedulingLink, listCalendlyEventTypes } from "./services/integrationService.js";
import { transferSipCall } from "./services/livekitService.js";

type AgentRuntime = {
  callId: string;
  ownerId: string;
  agentId: string;
  name: string;
  pipelineMode: "realtime" | "pipeline";
  realtimeProvider: "openai" | "gemini";
  realtimeModel: string;
  llmProvider: "openai" | "gemini" | "sarvam";
  llmModel: string;
  sttProvider: "openai" | "sarvam";
  sttModel: string;
  ttsProvider: "openai" | "gemini" | "sarvam";
  ttsModel: string;
  temperature: number;
  voiceSpeed: number;
  voicePitch: number;
  interruptionSensitivity: "low" | "medium" | "high";
  backgroundNoise: "none" | "office" | "cafe" | "street";
  prompt: string;
  firstMessage: string;
  language: string;
  voice: string;
  behavior: {
    interruptions: boolean;
    userStartsFirst: boolean;
    responseDelayMs: number;
    maxCallDurationSeconds: number;
    maxIdleSeconds: number;
    transferPhone?: string;
  };
  tools: {
    name: string;
    description: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    timeoutSeconds: number;
    enabled: boolean;
  }[];
  prefetchWebhook: string;
  endOfCallWebhook: string;
};

const defaultRuntime: AgentRuntime = {
  callId: "",
  ownerId: "",
  agentId: "",
  name: "Voice assistant",
  pipelineMode: "realtime",
  realtimeProvider: "openai",
  realtimeModel: "gpt-realtime",
  llmProvider: "openai",
  llmModel: "gpt-4.1-mini",
  sttProvider: "openai",
  sttModel: "gpt-4o-mini-transcribe",
  ttsProvider: "openai",
  ttsModel: "gpt-4o-mini-tts",
  temperature: 0.35,
  voiceSpeed: 1,
  voicePitch: 0,
  interruptionSensitivity: "medium",
  backgroundNoise: "none",
  prompt:
    "You are a helpful realtime voice assistant. Keep responses concise, natural, and easy to understand when spoken aloud.",
  firstMessage: "Hello, how can I help today?",
  language: "English",
  voice: "alloy",
  behavior: {
    interruptions: true,
    userStartsFirst: false,
    responseDelayMs: 180,
    maxCallDurationSeconds: 1200,
    maxIdleSeconds: 18,
  },
  tools: [],
  prefetchWebhook: "",
  endOfCallWebhook: "",
};

const openaiRealtimeVoices = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

function parseRuntime(ctx: JobContext): AgentRuntime {
  const raw = ctx.job.metadata || ctx.room.metadata;
  if (!raw) {
    return defaultRuntime;
  }

  try {
    return { ...defaultRuntime, ...(JSON.parse(raw) as Partial<AgentRuntime>) };
  } catch {
    return defaultRuntime;
  }
}

function callerParticipant(session: voice.AgentSession) {
  const room = session._roomIO?.rtcRoom;
  if (!room) return null;
  return [...room.remoteParticipants.values()].find((participant) => participant.kind !== ParticipantKind.AGENT) ?? null;
}

function waitForCallerParticipant(session: voice.AgentSession, timeoutMs = 45000) {
  const existing = callerParticipant(session);
  if (existing) return Promise.resolve(existing);

  const room = session._roomIO?.rtcRoom;
  if (!room) return Promise.resolve(null);

  return new Promise<RemoteParticipant | null>((resolve) => {
    const cleanup = (participant: RemoteParticipant | null) => {
      clearTimeout(timeout);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      resolve(participant);
    };
    const onParticipantConnected = (participant: RemoteParticipant) => {
      if (participant.kind !== ParticipantKind.AGENT) cleanup(participant);
    };
    const timeout = setTimeout(() => cleanup(callerParticipant(session)), timeoutMs);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  });
}

class Assistant extends voice.Agent {
  constructor(
    instructions: string,
    private readonly firstMessage: string,
    private readonly userStartsFirst: boolean,
    tools: llm.ToolContext,
  ) {
    super({ instructions, tools });
  }

  override async onEnter() {
    if (this.userStartsFirst) return;
    const participant = await waitForCallerParticipant(this.session);
    if (!participant) {
      console.warn(JSON.stringify({ event: "agent-greeting-skipped-no-caller" }));
      return;
    }
    await this.session.generateReply({
      instructions: `Greet the caller now using this exact opening message: ${this.firstMessage}`,
    });
  }
}

function languageCode(runtime: AgentRuntime, indianEnglish = false) {
  const language = findLanguage(runtime.language);
  if (language?.value === "Multilingual") return indianEnglish ? "unknown" : "en-US";
  if (language?.value === "English") return indianEnglish ? "en-IN" : "en-US";
  return language?.code ?? (indianEnglish ? "en-IN" : "en-US");
}

function findLanguage(value: string) {
  const normalized = value.trim().toLowerCase();
  return voiceLanguages.find((language) =>
    [language.value, language.label, language.code].some((candidate) => candidate.toLowerCase() === normalized),
  );
}

function sarvamSttLanguageCode(runtime: AgentRuntime) {
  const language = findLanguage(runtime.language);
  if (!language || !language.sarvamStt) return "unknown";
  return language.code;
}

function saarikaLanguageCode(runtime: AgentRuntime) {
  const legacyCodes = new Set([
    "unknown",
    "hi-IN",
    "bn-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "od-IN",
    "pa-IN",
    "ta-IN",
    "te-IN",
    "en-IN",
    "gu-IN",
  ]);
  const code = sarvamSttLanguageCode(runtime);
  return legacyCodes.has(code) ? code : "unknown";
}

function sarvamTtsLanguageCode(runtime: AgentRuntime) {
  const language = findLanguage(runtime.language);
  return language?.sarvamTts ? language.code : "en-IN";
}

function createRealtimeSession(runtime: AgentRuntime) {
  if (runtime.realtimeProvider === "gemini") {
    return new voice.AgentSession({
      aecWarmupDuration: 800,
      llm: new google.realtime.RealtimeModel({
        apiKey: env.googleApiKey,
        model: runtime.realtimeModel,
        voice: runtime.voice,
        language: languageCode(runtime),
        instructions: runtime.prompt,
      }),
    });
  }

  return new voice.AgentSession({
    aecWarmupDuration: 800,
    llm: new openai.realtime.RealtimeModel({
      apiKey: env.openaiApiKey,
      model: runtime.realtimeModel,
      voice: openaiRealtimeVoices.has(runtime.voice) ? runtime.voice : "alloy",
      speed: runtime.voiceSpeed,
      turnDetection: {
        type: "server_vad",
        threshold: runtime.interruptionSensitivity === "high" ? 0.42 : runtime.interruptionSensitivity === "low" ? 0.72 : 0.58,
        prefix_padding_ms: 180,
        silence_duration_ms: 220,
      },
    }),
  });
}

function createStt(runtime: AgentRuntime, vad: silero.VAD) {
  if (runtime.sttProvider === "sarvam") {
    if (runtime.sttModel === "saaras:v2.5") {
      return new sarvam.STT({
        apiKey: env.sarvamApiKey,
        model: "saaras:v2.5",
        mode: "translate",
        prompt: runtime.prompt.slice(0, 500),
      });
    }
    if (runtime.sttModel === "saarika:v2.5") {
      return new sarvam.STT({
        apiKey: env.sarvamApiKey,
        model: "saarika:v2.5",
        languageCode: saarikaLanguageCode(runtime),
      });
    }
    return new sarvam.STT({
      apiKey: env.sarvamApiKey,
      model: "saaras:v3",
      languageCode: sarvamSttLanguageCode(runtime),
      mode: "transcribe",
      highVadSensitivity: true,
    });
  }

  return new openai.STT({
    apiKey: env.openaiApiKey,
    model: runtime.sttModel,
    language: languageCode(runtime),
    detectLanguage: runtime.language === "Multilingual",
    useRealtime: runtime.sttModel === "gpt-realtime-whisper",
    vad,
  });
}

function createLlm(runtime: AgentRuntime) {
  if (runtime.llmProvider === "gemini") {
    return new google.LLM({
      apiKey: env.googleApiKey,
      model: runtime.llmModel,
      temperature: runtime.temperature,
      maxOutputTokens: 220,
    });
  }
  if (runtime.llmProvider === "sarvam") {
    return new openai.LLM({
      apiKey: env.sarvamApiKey,
      baseURL: "https://api.sarvam.ai/v1",
      model: runtime.llmModel,
      temperature: runtime.temperature,
      maxCompletionTokens: 220,
    });
  }
  return new openai.LLM({
    apiKey: env.openaiApiKey,
    model: runtime.llmModel,
    temperature: runtime.llmModel.startsWith("gpt-5") ? undefined : runtime.temperature,
    maxCompletionTokens: 220,
  });
}

function createTts(runtime: AgentRuntime) {
  if (runtime.ttsProvider === "gemini") {
    return new google.beta.TTS({
      apiKey: env.googleApiKey,
      model: runtime.ttsModel,
      voiceName: runtime.voice,
      instructions: "Speak naturally, clearly, and with low latency.",
    });
  }
  if (runtime.ttsProvider === "sarvam") {
    if (runtime.ttsModel === "bulbul:v2") {
      const v2Voices = ["anushka", "manisha", "vidya", "arya", "abhilash", "karun", "hitesh"];
      return new sarvam.TTS({
        apiKey: env.sarvamApiKey,
        model: "bulbul:v2",
        speaker: v2Voices.includes(runtime.voice) ? runtime.voice : "anushka",
        targetLanguageCode: sarvamTtsLanguageCode(runtime),
        pace: runtime.voiceSpeed,
      });
    }
    const v3Voices = [
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
    return new sarvam.TTS({
      apiKey: env.sarvamApiKey,
      model: "bulbul:v3",
      speaker: v3Voices.includes(runtime.voice) ? runtime.voice : "shubh",
      targetLanguageCode: sarvamTtsLanguageCode(runtime),
      pace: runtime.voiceSpeed,
    });
  }
  return new openai.TTS({
    apiKey: env.openaiApiKey,
    model: runtime.ttsModel,
    voice: runtime.voice as openai.TTSVoices,
    speed: runtime.voiceSpeed,
    instructions: "Speak naturally, clearly, and with low latency.",
  });
}

function createPipelineSession(runtime: AgentRuntime, vad: silero.VAD) {
  const responseDelayMs = Math.min(1000, Math.max(120, runtime.behavior.responseDelayMs));
  return new voice.AgentSession({
    aecWarmupDuration: 800,
    vad,
    stt: createStt(runtime, vad),
    llm: createLlm(runtime),
    tts: createTts(runtime),
    turnHandling: {
      turnDetection: "vad",
      preemptiveGeneration: { enabled: true },
      interruption: { enabled: runtime.behavior.interruptions, minDuration: runtime.interruptionSensitivity === "high" ? 0.12 : runtime.interruptionSensitivity === "low" ? 0.5 : 0.25 },
      endpointing: {
        minDelay: responseDelayMs,
        maxDelay: Math.max(500, responseDelayMs + 450),
      },
    },
  });
}

function attachCallTracking(session: voice.AgentSession, runtime: AgentRuntime, roomName: string) {
  let pendingUserTurnEndedAt: number | null = null;
  const pendingWrites = new Set<Promise<void>>();

  const markUserTurnEnded = (createdAt?: number) => {
    pendingUserTurnEndedAt = createdAt ?? Date.now();
  };

  const recordLatency = (agentStartedSpeakingAt?: number) => {
    if (!runtime.agentId || pendingUserTurnEndedAt === null) {
      return;
    }

    const latencyMs = (agentStartedSpeakingAt ?? Date.now()) - pendingUserTurnEndedAt;
    pendingUserTurnEndedAt = null;
    if (latencyMs < 0 || latencyMs > 60000) {
      return;
    }

    const write = Promise.all([
      recordAgentLatency(runtime.agentId, latencyMs),
      recordCallLatency(roomName, latencyMs),
    ])
      .then(() => {
        console.log(
          JSON.stringify({
            event: "agent-response-latency-recorded",
            room: roomName,
            agentId: runtime.agentId,
            latencyMs: Math.round(latencyMs),
          }),
        );
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "agent-response-latency-failed",
            room: roomName,
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });

    pendingWrites.add(write);
    void write.finally(() => {
      pendingWrites.delete(write);
    });
  };

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    if (event.newState === "speaking") {
      pendingUserTurnEndedAt = null;
    }
    if (event.oldState === "speaking" && event.newState !== "speaking") {
      markUserTurnEnded(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (event.isFinal && event.transcript.trim() && pendingUserTurnEndedAt === null) {
      markUserTurnEnded(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    if (event.newState === "speaking") {
      recordLatency(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type !== "message") return;
    const text = event.item.textContent?.trim();
    if (!text || !["user", "assistant", "system", "developer"].includes(event.item.role)) return;
    const write = appendTranscriptItem({
      roomName,
      itemId: event.item.id,
      role: event.item.role === "assistant" ? "assistant" : event.item.role === "user" ? "user" : "system",
      text,
      timestamp: new Date(event.item.createdAt),
      interrupted: event.item.interrupted,
    }).then(() => undefined);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  });

  session.on(voice.AgentSessionEventTypes.Error, (event) => {
    const write = failCall(roomName, event.error).then(() => undefined);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  });

  session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (event) => {
    const write = recordCallUsage(roomName, event.usage).then(() => undefined);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  });

  session.on(voice.AgentSessionEventTypes.Close, (event) => {
    const write = event.error
      ? failCall(roomName, event.error).then(() => undefined)
      : completeCall(roomName, event.reason).then(() => undefined);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
    void Promise.allSettled([...pendingWrites]);
  });
}

function createWebhookTools(runtime: AgentRuntime, roomName: string): llm.ToolContext {
  const customTools = Object.fromEntries(
    runtime.tools
      .filter((tool) => tool.enabled)
      .map((tool) => [
        tool.name,
        llm.tool({
          description: tool.description || `Call the ${tool.name} webhook.`,
          parameters: {
            type: "object",
            additionalProperties: true,
          },
          execute: async (args) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), tool.timeoutSeconds * 1000);
            try {
              const url = new URL(tool.url);
              const init: RequestInit = {
                method: tool.method,
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
              };
              if (tool.method === "GET") {
                for (const [key, value] of Object.entries(args)) {
                  url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
                }
              } else {
                init.body = JSON.stringify(args);
              }
              const response = await fetch(url, init);
              const text = (await response.text()).slice(0, 10000);
              if (!response.ok) throw new llm.ToolError(`${tool.name} returned HTTP ${response.status}: ${text}`);
              return text || `The ${tool.name} action completed successfully.`;
            } finally {
              clearTimeout(timeout);
            }
          },
        }),
      ]),
  );
  return {
    ...customTools,
    check_calendly_event_types: llm.tool({
      description: "List the organization's active Calendly event types when the caller wants to book an appointment.",
      parameters: { type: "object", properties: {} },
      execute: async () => JSON.stringify(await listCalendlyEventTypes(runtime.ownerId)),
    }),
    create_calendly_scheduling_link: llm.tool({
      description: "Create a one-time Calendly scheduling link for an event type URI selected by the caller.",
      parameters: {
        type: "object",
        properties: { eventTypeUri: { type: "string", description: "Calendly event type URI." } },
        required: ["eventTypeUri"],
      },
      execute: async (args) => JSON.stringify(await createCalendlySchedulingLink(runtime.ownerId, String(args.eventTypeUri ?? ""))),
    }),
    transfer_to_human: llm.tool({
      description: "Transfer the connected phone caller to the configured human handoff number when they ask for a person.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        if (!runtime.behavior.transferPhone) throw new llm.ToolError("No human transfer number is configured.");
        return JSON.stringify(await transferSipCall(roomName, runtime.behavior.transferPhone));
      },
    }),
  };
}

async function callLifecycleWebhook(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = 8000,
) {
  if (!url) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = (await response.text()).slice(0, 10000);
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

type ProcessData = { vad?: silero.VAD };

export default defineAgent({
  prewarm: async (proc: JobProcess<ProcessData>) => {
    const [vad] = await Promise.all([silero.VAD.load(), connectDatabase()]);
    proc.userData.vad = vad;
  },
  entry: async (ctx: JobContext<ProcessData>) => {
    await ctx.connect();

    const runtime = parseRuntime(ctx);
    const roomName = ctx.room.name ?? "unknown-room";
    await markCallActive(roomName, ctx.job.metadata || ctx.room.metadata);
    if (runtime.prefetchWebhook) {
      try {
        const context = await callLifecycleWebhook(runtime.prefetchWebhook, {
          event: "call_started",
          callId: runtime.callId,
          roomName,
          agentId: runtime.agentId,
        });
        if (context) runtime.prompt = `${runtime.prompt}\n\nPrefetched call context:\n${context}`;
      } catch (error) {
        console.error(JSON.stringify({ event: "prefetch-webhook-failed", room: roomName, error: String(error) }));
      }
    }
    console.log(
      JSON.stringify({
        event: "voice-agent-job-started",
        room: roomName,
        agentName: env.livekitAgentName,
        pipelineMode: runtime.pipelineMode,
        realtimeProvider: runtime.realtimeProvider,
        realtimeModel: runtime.realtimeModel,
        llmProvider: runtime.llmProvider,
        sttProvider: runtime.sttProvider,
        ttsProvider: runtime.ttsProvider,
        voice: runtime.voice,
        language: runtime.language,
      }),
    );
    const session =
      runtime.pipelineMode === "pipeline"
        ? createPipelineSession(runtime, ctx.proc.userData.vad ?? (await silero.VAD.load()))
        : createRealtimeSession(runtime);
    attachCallTracking(session, runtime, roomName);

    await session.start({
      agent: new Assistant(
        runtime.prompt,
        runtime.firstMessage,
        runtime.behavior.userStartsFirst,
        createWebhookTools(runtime, roomName),
      ),
      room: ctx.room,
    });
    const maxDurationTimer = setTimeout(
      () => session.shutdown({ reason: "max_call_duration" }),
      runtime.behavior.maxCallDurationSeconds * 1000,
    );
    session.once(voice.AgentSessionEventTypes.Close, () => clearTimeout(maxDurationTimer));
    session.once(voice.AgentSessionEventTypes.Close, (event) => {
      void callLifecycleWebhook(runtime.endOfCallWebhook, {
        event: "call_ended",
        callId: runtime.callId,
        roomName,
        agentId: runtime.agentId,
        reason: event.reason,
        error: event.error ? String(event.error) : "",
      }).catch((error) => {
        console.error(JSON.stringify({ event: "end-call-webhook-failed", room: roomName, error: String(error) }));
      });
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: env.livekitAgentName,
  }),
);
