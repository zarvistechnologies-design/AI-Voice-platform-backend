import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";

import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { recordAgentLatency } from "./services/latencyService.js";

type AgentRuntime = {
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
  prompt: string;
  firstMessage: string;
  language: string;
  voice: string;
};

const defaultRuntime: AgentRuntime = {
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
  prompt:
    "You are a helpful realtime voice assistant. Keep responses concise, natural, and easy to understand when spoken aloud.",
  firstMessage: "Hello, how can I help today?",
  language: "English",
  voice: "alloy",
};

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

class Assistant extends voice.Agent {
  constructor(
    instructions: string,
    private readonly firstMessage: string,
  ) {
    super({ instructions });
  }

  override async onEnter() {
    await this.session.generateReply({
      instructions: `Greet the caller now using this exact opening message: ${this.firstMessage}`,
    });
  }
}

function languageCode(runtime: AgentRuntime, indianEnglish = false) {
  if (runtime.language === "Hindi") return "hi-IN";
  if (runtime.language === "English UK") return "en-GB";
  return indianEnglish ? "en-IN" : "en-US";
}

function createRealtimeSession(runtime: AgentRuntime) {
  if (runtime.realtimeProvider === "gemini") {
    return new voice.AgentSession({
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
    llm: new openai.realtime.RealtimeModel({
      apiKey: env.openaiApiKey,
      model: runtime.realtimeModel,
      voice: runtime.voice || "alloy",
      turnDetection: {
        type: "server_vad",
        threshold: 0.58,
        prefix_padding_ms: 240,
        silence_duration_ms: 320,
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
        languageCode: languageCode(runtime, true),
      });
    }
    return new sarvam.STT({
      apiKey: env.sarvamApiKey,
      model: "saaras:v3",
      languageCode: languageCode(runtime, true),
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
        targetLanguageCode: languageCode(runtime, true),
        pace: 1.08,
      });
    }
    return new sarvam.TTS({
      apiKey: env.sarvamApiKey,
      model: "bulbul:v3",
      speaker: runtime.voice || "shubh",
      targetLanguageCode: languageCode(runtime, true),
      pace: 1.08,
    });
  }
  return new openai.TTS({
    apiKey: env.openaiApiKey,
    model: runtime.ttsModel,
    voice: runtime.voice as openai.TTSVoices,
    speed: 1.05,
    instructions: "Speak naturally, clearly, and with low latency.",
  });
}

function createPipelineSession(runtime: AgentRuntime, vad: silero.VAD) {
  return new voice.AgentSession({
    vad,
    stt: createStt(runtime, vad),
    llm: createLlm(runtime),
    tts: createTts(runtime),
    turnHandling: {
      turnDetection: "vad",
      interruption: { enabled: true, minDuration: 0.25 },
      preemptiveGeneration: { enabled: true },
      endpointing: { minDelay: 0.25, maxDelay: 1.2 },
    },
  });
}

function attachLatencyTracking(session: voice.AgentSession, runtime: AgentRuntime, roomName: string) {
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

    const write = recordAgentLatency(runtime.agentId, latencyMs)
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

  session.on(voice.AgentSessionEventTypes.Close, () => {
    void Promise.allSettled([...pendingWrites]);
  });
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
    attachLatencyTracking(session, runtime, roomName);

    await session.start({
      agent: new Assistant(runtime.prompt, runtime.firstMessage),
      room: ctx.room,
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: env.livekitAgentName,
  }),
);
