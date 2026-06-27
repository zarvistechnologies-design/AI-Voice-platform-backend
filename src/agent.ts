import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  type VAD,
  voice,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { ParticipantKind, RoomEvent, type RemoteParticipant } from "@livekit/rtc-node";
import type { JSONSchema7 } from "json-schema";
import { fileURLToPath } from "node:url";

import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { VoiceAgentModel } from "./models/VoiceAgent.js";
import { recordAgentLatency } from "./services/latencyService.js";
import { searchKnowledgeBase, type KnowledgeRetrievalDocument } from "./services/knowledgeRetrievalService.js";
import { sarvamV2Voices, sarvamV3Voices, voiceLanguages } from "./services/modelCatalog.js";
import {
  appendTranscriptItem,
  completeCall,
  failCall,
  getPreviousCallerContext,
  markCallActive,
  markDoNotCallDetected,
  markVoicemailDetected,
  recordCallLatency,
  recordCallUsage,
} from "./services/callRecordService.js";
import { createCalendlySchedulingLink, listCalendlyEventTypes } from "./services/integrationService.js";
import { startCallRecording, transferSipCall } from "./services/livekitService.js";
import { executeWebhookTool, objectArgs } from "./services/agentToolService.js";

type FirstMessageMode = "assistant-speaks-first" | "user-speaks-first" | "model-generated";
type ToolParameter = {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
};

type AgentRuntime = {
  callId: string;
  callDirection: "web" | "inbound" | "outbound" | "";
  callerParticipantIdentity: string;
  fromPhone: string;
  toPhone: string;
  metadata: Record<string, unknown>;
  variables: Record<string, unknown>;
  timezone: string;
  ownerId: string;
  agentId: string;
  name: string;
  pipelineMode: "realtime" | "pipeline";
  realtimeProvider: "openai" | "gemini";
  realtimeModel: string;
  llmProvider: "openai" | "gemini" | "sarvam";
  llmModel: string;
  sttProvider: "openai" | "sarvam" | "elevenlabs";
  sttModel: string;
  ttsProvider: "openai" | "gemini" | "sarvam" | "elevenlabs";
  ttsModel: string;
  temperature: number;
  voiceSpeed: number;
  voicePitch: number;
  interruptionSensitivity: "low" | "medium" | "high";
  backgroundNoise: "none" | "office" | "cafe" | "street";
  prompt: string;
  firstMessage: string;
  firstMessageMode: FirstMessageMode;
  language: string;
  voice: string;
  behavior: {
    interruptions: boolean;
    userStartsFirst: boolean;
    autoFillResponses: boolean;
    agentCanTerminate: boolean;
    voicemailHandling: boolean;
    voicemailAction: "leave-message" | "hangup";
    dtmfDial: boolean;
    dtmfSequence: string;
    endpointingMode: "fast" | "balanced" | "patient";
    responseDelayMs: number;
    maxCallDurationSeconds: number;
    maxIdleSeconds: number;
    transferPhone?: string;
    voicemailMessage: string;
  };
  callSettings: {
    recordingEnabled: boolean;
    doNotCallDetection: boolean;
    sessionContinuation: boolean;
    memoryEnabled: boolean;
  };
  tools: {
    name: string;
    description: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    timeoutSeconds: number;
    enabled: boolean;
    parameters?: ToolParameter[];
    runAfterCall?: boolean;
    executeAfterMessage?: boolean;
    excludeSessionId?: boolean;
    messages?: string[];
  }[];
  knowledgeDocuments: KnowledgeRetrievalDocument[];
  prefetchWebhook: string;
  endOfCallWebhook: string;
};

const defaultRuntime: AgentRuntime = {
  callId: "",
  callDirection: "",
  callerParticipantIdentity: "",
  fromPhone: "",
  toPhone: "",
  metadata: {},
  variables: {},
  timezone: "UTC",
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
  firstMessageMode: "assistant-speaks-first",
  language: "English",
  voice: "alloy",
  behavior: {
    interruptions: true,
    userStartsFirst: false,
    autoFillResponses: true,
    agentCanTerminate: true,
    voicemailHandling: true,
    voicemailAction: "leave-message",
    dtmfDial: false,
    dtmfSequence: "",
    endpointingMode: "fast",
    responseDelayMs: 80,
    maxCallDurationSeconds: 1200,
    maxIdleSeconds: 18,
    voicemailMessage: "Sorry we missed you. Please leave a message after the tone.",
  },
  callSettings: {
    recordingEnabled: false,
    doNotCallDetection: false,
    sessionContinuation: false,
    memoryEnabled: false,
  },
  tools: [],
  knowledgeDocuments: [],
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

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseRuntime(ctx: JobContext): AgentRuntime {
  const raw = ctx.job.metadata || ctx.room.metadata;
  if (!raw) {
    return defaultRuntime;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AgentRuntime>;
    return {
      ...defaultRuntime,
      ...parsed,
      behavior: {
        ...defaultRuntime.behavior,
        ...(parsed.behavior ?? {}),
      },
      callSettings: {
        ...defaultRuntime.callSettings,
        ...(parsed.callSettings ?? {}),
      },
      metadata: objectRecord(parsed.metadata),
      variables: objectRecord(parsed.variables),
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      knowledgeDocuments: Array.isArray(parsed.knowledgeDocuments)
        ? parsed.knowledgeDocuments
          .map((document) => objectRecord(document))
          .map((document) => ({
            name: typeof document.name === "string" ? document.name : "",
            content: typeof document.content === "string" ? document.content : "",
            status: document.status === "disabled" ? "disabled" as const : "ready" as const,
          }))
          .filter((document) => document.name && document.content)
        : [],
    };
  } catch {
    return defaultRuntime;
  }
}

async function refreshRuntimeAgentData(runtime: AgentRuntime) {
  if (!runtime.agentId || !runtime.ownerId) return;
  const agent = await VoiceAgentModel.findOne({
    _id: runtime.agentId,
    ownerId: runtime.ownerId,
  })
    .select("language knowledgeDocuments")
    .lean();
  if (agent?.language?.trim()) {
    runtime.language = agent.language.trim();
  }
  if (Array.isArray(agent?.knowledgeDocuments)) {
    runtime.knowledgeDocuments = agent.knowledgeDocuments
      .filter((document) => document.status === "ready")
      .map((document) => ({
        name: document.name,
        content: document.content,
        status: document.status,
      }));
  }
}

function transcriptItemId(prefix: string, text: string, createdAt: number) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${prefix}-${createdAt}-${Math.abs(hash).toString(36)}`;
}

function participantKind(participant: RemoteParticipant) {
  return participant.kind ?? participant.info.kind;
}

function callerParticipant(session: voice.AgentSession, expectedIdentity = "") {
  const room = session._roomIO?.rtcRoom;
  if (!room) return null;
  if (expectedIdentity) {
    const participant = room.remoteParticipants.get(expectedIdentity);
    if (participant && participantKind(participant) !== ParticipantKind.AGENT) {
      return participant;
    }
    return null;
  }
  return [...room.remoteParticipants.values()].find((participant) => participantKind(participant) !== ParticipantKind.AGENT) ?? null;
}

function waitForCallerParticipant(session: voice.AgentSession, expectedIdentity = "", timeoutMs = 45000) {
  const existing = callerParticipant(session, expectedIdentity);
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
      if (expectedIdentity && participant.identity !== expectedIdentity) return;
      if (participantKind(participant) !== ParticipantKind.AGENT) cleanup(participant);
    };
    const timeout = setTimeout(() => cleanup(callerParticipant(session, expectedIdentity)), timeoutMs);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  });
}

function effectiveFirstMessageMode(runtime: AgentRuntime): FirstMessageMode {
  return runtime.behavior.userStartsFirst ? "user-speaks-first" : runtime.firstMessageMode;
}

function safeTimezone(timezone: string) {
  const candidate = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function stringifyVariables(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? ""
          : typeof value === "object" ? JSON.stringify(value) : String(value),
    ]),
  );
}

function currentTimeVariables(timezone: string) {
  const timeZone = safeTimezone(timezone);
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(now);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(now);
  const isoParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const date = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const time = Object.fromEntries(timeParts.map((part) => [part.type, part.value]));
  const currentTime = [time.hour, time.minute, time.second].filter(Boolean).join(":");
  const currentDate = `${date.month} ${date.day}, ${date.year}`;
  const currentIsoDate = [isoParts.year, isoParts.month, isoParts.day].filter(Boolean).join("-");
  const currentDateTime = `${currentDate} ${currentTime} ${time.timeZoneName ?? timeZone}`.trim();
  const currentCalendar = `${date.weekday ?? ""}, ${currentDate}`.replace(/^,\s*/, "");
  return {
    CurrentDate: currentDate,
    CurrentISODate: currentIsoDate,
    CurrentTime: currentTime,
    CurrentHour: String(time.hour ?? ""),
    CurrentDay: String(date.weekday ?? ""),
    CurrentMonth: String(date.month ?? ""),
    CurrentYear: String(date.year ?? ""),
    CurrentDateTime: currentDateTime,
    Timezone: timeZone,
    now: currentDateTime,
    date: currentDate,
    iso_date: currentIsoDate,
    time: currentTime,
    day: String(date.weekday ?? ""),
    month: String(date.month ?? ""),
    year: String(date.year ?? ""),
    timezone: timeZone,
    current_time: currentDateTime,
    current_hour: String(time.hour ?? ""),
    current_calendar: currentCalendar,
  };
}

function timezoneFromVariableSuffix(suffix: string) {
  const trimmed = suffix.trim();
  if (!trimmed) return "";
  if (safeTimezone(trimmed) === trimmed) return trimmed;
  const slashCandidate = trimmed.includes("_")
    ? `${trimmed.split("_")[0]}/${trimmed.split("_").slice(1).join("_")}`
    : trimmed.replace(/-/g, "/");
  return safeTimezone(slashCandidate) === slashCandidate ? slashCandidate : "";
}

function dynamicDateTimeVariable(key: string) {
  const matches = [
    ["current_time_", "current_time"],
    ["current_hour_", "current_hour"],
    ["current_calendar_", "current_calendar"],
    ["CurrentDateTime_", "CurrentDateTime"],
    ["CurrentDate_", "CurrentDate"],
    ["CurrentISODate_", "CurrentISODate"],
    ["CurrentTime_", "CurrentTime"],
    ["CurrentHour_", "CurrentHour"],
    ["CurrentDay_", "CurrentDay"],
    ["date_", "date"],
    ["time_", "time"],
    ["day_", "day"],
  ] as const;

  for (const [prefix, field] of matches) {
    if (!key.startsWith(prefix)) continue;
    const timezone = timezoneFromVariableSuffix(key.slice(prefix.length));
    if (!timezone) return "";
    return currentTimeVariables(timezone)[field] ?? "";
  }

  return "";
}

function runtimeVariableMap(runtime: AgentRuntime, roomName = ""): Record<string, string> {
  const time = currentTimeVariables(runtime.timezone);
  const merged = stringifyVariables({
    ...runtime.metadata,
    ...runtime.variables,
    FromPhone: runtime.fromPhone,
    ToPhone: runtime.toPhone,
    from: runtime.fromPhone,
    to: runtime.toPhone,
    from_phone: runtime.fromPhone,
    to_phone: runtime.toPhone,
    CallId: runtime.callId,
    SessionId: runtime.callId || roomName,
    RoomName: roomName,
    AgentId: runtime.agentId,
    AgentName: runtime.name,
    CallDirection: runtime.callDirection,
    SelectedLanguage: runtime.language,
    selected_language: runtime.language,
    language: runtime.language,
    ...time,
  });
  return merged;
}

function variableValue(key: string, variables: Record<string, string>) {
  return variables[key] ?? dynamicDateTimeVariable(key);
}

function replaceVariables(text: string, variables: Record<string, string>) {
  const replaceKey = (match: string, rawKey: string) => {
    const key = rawKey.trim();
    const value = variableValue(key, variables);
    return value === undefined || value === "" ? match : value;
  };
  return text
    .replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_/-]{0,140})\s*\}\}/g, replaceKey)
    .replace(/\{([a-zA-Z][a-zA-Z0-9_/-]{0,140})\}/g, replaceKey);
}

function replaceVariablesInValue(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") return replaceVariables(value, variables);
  if (Array.isArray(value)) return value.map((item) => replaceVariablesInValue(item, variables));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      replaceVariablesInValue(item, variables),
    ]),
  );
}

function variableReference(value: string) {
  const trimmed = value.trim();
  return trimmed.match(/^\{\{\s*([a-zA-Z][a-zA-Z0-9_/-]{0,140})\s*\}\}$/)?.[1]
    ?? trimmed.match(/^\{([a-zA-Z][a-zA-Z0-9_/-]{0,140})\}$/)?.[1]
    ?? "";
}

function resolveToolArgs(tool: AgentRuntime["tools"][number], args: unknown, variables: Record<string, string>) {
  const resolved = objectArgs(replaceVariablesInValue(args, variables));
  for (const parameter of tool.parameters ?? []) {
    const key = variableReference(parameter.description);
    const value = key ? variableValue(key, variables) : "";
    if (!value) continue;
    const current = resolved[parameter.name];
    if (current === undefined || current === "" || current === parameter.description.trim()) {
      resolved[parameter.name] = value;
    }
  }
  return resolved;
}

function setRuntimeVariable(runtime: AgentRuntime, key: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  runtime.variables[key] = trimmed;
}

function syncRuntimePhones(runtime: AgentRuntime, values: { fromPhone?: string; toPhone?: string }) {
  if (values.fromPhone?.trim()) {
    runtime.fromPhone = values.fromPhone.trim();
    setRuntimeVariable(runtime, "FromPhone", runtime.fromPhone);
  }
  if (values.toPhone?.trim()) {
    runtime.toPhone = values.toPhone.trim();
    setRuntimeVariable(runtime, "ToPhone", runtime.toPhone);
  }
}

function syncRuntimeVariablesFromParticipant(runtime: AgentRuntime, participant: RemoteParticipant) {
  const attributes = participant.attributes ?? {};
  const sipPhone = attributes["sip.phoneNumber"] || "";
  const trunkPhone = attributes["sip.trunkPhoneNumber"] || "";
  const participantPhone = participant.name || "";

  if (runtime.callDirection === "inbound") {
    syncRuntimePhones(runtime, {
      fromPhone: sipPhone || participantPhone,
      toPhone: runtime.toPhone || trunkPhone,
    });
  } else if (runtime.callDirection === "outbound") {
    syncRuntimePhones(runtime, {
      fromPhone: runtime.fromPhone || trunkPhone,
      toPhone: runtime.toPhone || sipPhone || participantPhone,
    });
  }
}

function sessionContextLines(variables: Record<string, string>) {
  return [
    `- Current date: ${variables.CurrentDate} (${variables.CurrentDay})`,
    `- Current time: ${variables.CurrentTime} ${variables.Timezone}`,
    `- Dashboard-selected conversation language: ${variables.SelectedLanguage}`,
    `- Vapi/Retell-style aliases: {{date}}=${variables.date}, {{time}}=${variables.time}, {{current_time}}=${variables.current_time}`,
    `- FromPhone: ${variables.FromPhone || "unknown"}`,
    `- ToPhone: ${variables.ToPhone || "unknown"}`,
    `- CallId: ${variables.CallId || variables.SessionId || "unknown"}`,
  ];
}

const doNotCallPatterns = [
  /\b(do not call|don't call|dont call|stop calling|stop contacting|unsubscribe|opt out|not interested|remove me|take me off|no more calls)\b/i,
  /\bremove (me|my number) from (your )?(call list|calling list|list)\b/i,
];

function detectsDoNotCallIntent(text: string) {
  return doNotCallPatterns.some((pattern) => pattern.test(text));
}

function conversationLanguageRules(runtime: AgentRuntime) {
  const language = findLanguage(runtime.language);
  if (language?.value === "Multilingual") {
    return [
      "Conversation language (authoritative):",
      "- Auto-detect mode is selected. Reply in the language the caller is currently using.",
      "- If the caller clearly switches languages, continue in the newly used language.",
      "- A fixed response-language instruction or example in the custom prompt must not override auto-detect mode.",
    ];
  }

  const selectedLanguage = language?.label || runtime.language.trim() || "English";
  const languageCode = language?.code && language.code !== "unknown" ? ` (${language.code})` : "";
  return [
    "Conversation language (authoritative):",
    `- The dashboard-selected language is ${selectedLanguage}${languageCode}.`,
    `- Speak every caller-facing response only in ${selectedLanguage}, even if the caller uses another language.`,
    `- Translate greetings, sample phrases, confirmations, dates, and canned wording from the custom prompt into ${selectedLanguage} before speaking.`,
    "- Preserve proper names, phone numbers, URLs, and tool arguments.",
    "- These selected-language rules override any conflicting response-language instruction or example in the custom prompt.",
  ];
}

function buildRuntimeInstructions(runtime: AgentRuntime, roomName = "") {
  const variables = runtimeVariableMap(runtime, roomName);
  const rules = [
    replaceVariables(runtime.prompt, variables),
    "",
    ...conversationLanguageRules(runtime),
    "",
    "Current session context:",
    ...sessionContextLines(variables),
    "- Treat the current date, day, time, timezone, and phone variables above as authoritative. Do not guess them.",
    "- Dynamic variables use {VariableName} or {{variable_name}} syntax. Resolve them from session context or call metadata before using tools.",
    "- Timezone-specific variables are supported, for example {{current_time_Asia/Kolkata}}, {{current_calendar_America/Los_Angeles}}, and {CurrentTime_Asia_Kolkata}.",
    runtime.knowledgeDocuments.length
      ? [
          "",
          "Knowledge base retrieval:",
          "- This agent has organization-approved knowledge documents.",
          "- For caller questions about business facts, policies, pricing, services, FAQs, locations, doctors, appointments, or document-specific details, call search_knowledge_base before answering.",
          "- Answer using retrieved snippets only. If no matching snippet is found, say the answer is not available in the knowledge base and offer a human handoff.",
        ].join("\n")
      : "",
    "",
    "Operational rules:",
    "- Speak in short, natural turns and ask one question at a time.",
    runtime.behavior.autoFillResponses
      ? "- When the caller gives partial information, infer obvious context but confirm important details before acting."
      : "- Do not infer missing caller details; ask for the exact information you need.",
    runtime.behavior.voicemailHandling && runtime.callDirection === "outbound"
      ? "- If you hear voicemail, an answering machine, or a mailbox greeting, call the voicemail_detected tool immediately."
      : "",
    runtime.callSettings.doNotCallDetection
      ? "- If the caller asks not to be called again or to opt out, acknowledge briefly and stop any promotional follow-up."
      : "",
    runtime.behavior.agentCanTerminate
      ? "- If the task is complete, the caller says goodbye, or the caller asks to end the call, call the end_call tool."
      : "- Do not end the call yourself unless the platform closes it.",
    runtime.behavior.dtmfDial && runtime.behavior.dtmfSequence
      ? `- This outbound call is configured to send DTMF sequence "${runtime.behavior.dtmfSequence}" after answer.`
      : "",
  ].filter(Boolean);
  return rules.join("\n");
}

class Assistant extends voice.Agent {
  constructor(
    instructions: string,
    private readonly firstMessage: string,
    private readonly firstMessageMode: FirstMessageMode,
    private readonly callerParticipantIdentity: string,
    private readonly runtime: AgentRuntime,
    private readonly roomName: string,
    tools: llm.ToolContext,
    private readonly beforeGreeting?: (session: voice.AgentSession) => Promise<boolean>,
  ) {
    super({ instructions, tools });
  }

  override async onEnter() {
    const startedAt = Date.now();
    const participant = await waitForCallerParticipant(this.session, this.callerParticipantIdentity);
    if (!participant) {
      console.warn(JSON.stringify({
        event: "agent-greeting-skipped-no-caller",
        expectedParticipantIdentity: this.callerParticipantIdentity,
        waitMs: Date.now() - startedAt,
      }));
      return;
    }
    syncRuntimeVariablesFromParticipant(this.runtime, participant);
    if (this.beforeGreeting && !(await this.beforeGreeting(this.session))) return;
    if (this.firstMessageMode === "user-speaks-first") return;
    console.log(JSON.stringify({
      event: "agent-caller-ready",
      participantIdentity: participant.identity,
      expectedParticipantIdentity: this.callerParticipantIdentity,
      waitMs: Date.now() - startedAt,
    }));
    if (this.firstMessageMode === "model-generated") {
      const variables = runtimeVariableMap(this.runtime, this.roomName);
      await this.session.generateReply({
        instructions: [
          "Greet the caller warmly in one concise sentence and invite them to explain what they need.",
          ...conversationLanguageRules(this.runtime),
          `Current date: ${variables.CurrentDate} (${variables.CurrentDay}).`,
          `Current time: ${variables.CurrentTime} ${variables.Timezone}.`,
        ].join(" "),
        allowInterruptions: false,
        inputModality: "text",
      });
    } else {
      const firstMessage = replaceVariables(
        this.firstMessage,
        runtimeVariableMap(this.runtime, this.roomName),
      );
      const language = findLanguage(this.runtime.language);
      if (language?.value === "Multilingual") {
        await this.session.say(firstMessage, {
          allowInterruptions: false,
          addToChatCtx: true,
        });
      } else {
        await this.session.generateReply({
          instructions: [
            `Deliver this configured opening message now: ${JSON.stringify(firstMessage)}.`,
            ...conversationLanguageRules(this.runtime),
            "Keep its meaning and proper names unchanged. Do not add any other information or question.",
          ].join(" "),
          allowInterruptions: false,
          inputModality: "text",
        });
      }
    }
    console.log(JSON.stringify({
      event: "agent-greeting-spoken",
      firstMessageMode: this.firstMessageMode,
      participantIdentity: participant.identity,
      elapsedMs: Date.now() - startedAt,
    }));
  }
}

function languageCode(runtime: AgentRuntime, fallback = "en-US") {
  const language = findLanguage(runtime.language);
  if (language?.value === "Multilingual") return fallback;
  return language?.code ?? fallback;
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

function runtimeTurnHandling(runtime: AgentRuntime, turnDetection: "realtime_llm" | "vad") {
  const endpointing = endpointingDelays(runtime);
  return {
    turnDetection,
    interruption: {
      enabled: runtime.behavior.interruptions,
      minDuration: runtime.interruptionSensitivity === "high"
        ? 120
        : runtime.interruptionSensitivity === "low" ? 500 : 250,
    },
    endpointing: {
      mode: runtime.behavior.endpointingMode === "balanced" ? "dynamic" as const : "fixed" as const,
      ...endpointing,
    },
  };
}

function createRealtimeSession(runtime: AgentRuntime) {
  if (runtime.realtimeProvider === "gemini") {
    return new voice.AgentSession({
      aecWarmupDuration: 800,
      turnHandling: runtimeTurnHandling(runtime, "realtime_llm"),
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
    turnHandling: runtimeTurnHandling(runtime, "realtime_llm"),
    llm: new openai.realtime.RealtimeModel({
      apiKey: env.openaiApiKey,
      model: runtime.realtimeModel,
      voice: openaiRealtimeVoices.has(runtime.voice) ? runtime.voice : "alloy",
      speed: runtime.voiceSpeed,
      turnDetection: {
        type: "server_vad",
        threshold: runtime.interruptionSensitivity === "high" ? 0.42 : runtime.interruptionSensitivity === "low" ? 0.72 : 0.58,
        prefix_padding_ms: 180,
        silence_duration_ms: Math.round(endpointingDelays(runtime).minDelay),
      },
    }),
  });
}

function createStt(runtime: AgentRuntime, vad: VAD) {
  if (runtime.sttProvider === "elevenlabs") {
    return new elevenlabs.STT({
      apiKey: env.elevenLabsApiKey,
      modelId: runtime.sttModel,
      languageCode: runtime.language === "Multilingual" ? undefined : languageCode(runtime),
    });
  }
  if (runtime.sttProvider === "sarvam") {
    if (runtime.sttModel === "saaras:v2.5") {
      return new sarvam.STT({
        apiKey: env.sarvamApiKey,
        model: "saaras:v2.5",
        mode: "translate",
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
  if (runtime.ttsProvider === "elevenlabs") {
    return new elevenlabs.TTS({
      apiKey: env.elevenLabsApiKey,
      model: runtime.ttsModel,
      voiceId: runtime.voice,
      languageCode: runtime.language === "Multilingual" ? undefined : languageCode(runtime),
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: runtime.voiceSpeed,
      },
    });
  }
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
      return new sarvam.TTS({
        apiKey: env.sarvamApiKey,
        model: "bulbul:v2",
        speaker: sarvamV2Voices.includes(runtime.voice) ? runtime.voice : "anushka",
        targetLanguageCode: sarvamTtsLanguageCode(runtime),
        pace: runtime.voiceSpeed,
      });
    }
    return new sarvam.TTS({
      apiKey: env.sarvamApiKey,
      model: "bulbul:v3",
      speaker: sarvamV3Voices.includes(runtime.voice) ? runtime.voice : "shubh",
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

function endpointingDelays(runtime: AgentRuntime) {
  const base = Math.min(1200, Math.max(80, runtime.behavior.responseDelayMs));
  if (runtime.behavior.endpointingMode === "fast") {
    return { minDelay: Math.min(500, base), maxDelay: Math.max(350, base + 250) };
  }
  if (runtime.behavior.endpointingMode === "patient") {
    return { minDelay: Math.max(350, base), maxDelay: Math.max(1200, base + 1200) };
  }
  return { minDelay: Math.min(900, Math.max(120, base)), maxDelay: Math.max(650, base + 550) };
}

function createPipelineSession(runtime: AgentRuntime, vad: VAD) {
  return new voice.AgentSession({
    aecWarmupDuration: 800,
    vad,
    stt: createStt(runtime, vad),
    llm: createLlm(runtime),
    tts: createTts(runtime),
    turnHandling: {
      ...runtimeTurnHandling(runtime, "vad"),
      preemptiveGeneration: { enabled: true },
    },
  });
}

function attachCallTracking(session: voice.AgentSession, runtime: AgentRuntime, roomName: string) {
  let pendingUserTurnEndedAt: number | null = null;
  const pendingWrites = new Set<Promise<void>>();
  const maxIdleMs = Math.max(10000, runtime.behavior.maxIdleSeconds * 1000);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let fillerTimer: ReturnType<typeof setTimeout> | null = null;
  let initialIdleWindow = true;
  let doNotCallMarked = false;
  const busyAgentStates = new Set(["initializing", "thinking", "speaking"]);

  const callIsBusy = () => busyAgentStates.has(session.agentState) || session.userState === "speaking";

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const waitMs = initialIdleWindow ? Math.max(90000, maxIdleMs) : maxIdleMs;
    initialIdleWindow = false;
    idleTimer = setTimeout(() => {
      if (callIsBusy()) {
        console.log(JSON.stringify({
          event: "agent-idle-timeout-deferred",
          room: roomName,
          waitMs,
          agentState: session.agentState,
          userState: session.userState,
        }));
        resetIdleTimer();
        return;
      }
      console.log(JSON.stringify({ event: "agent-max-idle-timeout", room: roomName, waitMs }));
      session.shutdown({ reason: "max_idle_timeout" });
    }, waitMs);
  };

  resetIdleTimer();

  const markUserTurnEnded = (createdAt?: number) => {
    pendingUserTurnEndedAt = createdAt ?? Date.now();
    resetIdleTimer();
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
      resetIdleTimer();
    }
    if (event.oldState === "speaking" && event.newState !== "speaking") {
      markUserTurnEnded(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    const transcript = event.transcript.trim();
    if (transcript) resetIdleTimer();
    if (
      runtime.callSettings.doNotCallDetection &&
      event.isFinal &&
      transcript &&
      !doNotCallMarked &&
      detectsDoNotCallIntent(transcript)
    ) {
      doNotCallMarked = true;
      const write = markDoNotCallDetected(roomName, transcript)
        .then(() => {
          console.log(JSON.stringify({ event: "do-not-call-detected", room: roomName }));
        })
        .catch((error) => {
          doNotCallMarked = false;
          console.error(JSON.stringify({
            event: "do-not-call-detection-failed",
            room: roomName,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    }
    if (runtime.pipelineMode === "pipeline" && event.isFinal && transcript) {
      const write = appendTranscriptItem({
        roomName,
        itemId: transcriptItemId("user-final", transcript, event.createdAt),
        role: "user",
        text: transcript,
        timestamp: new Date(event.createdAt),
        dedupeText: true,
      }).then(() => undefined);
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    }
    if (event.isFinal && transcript && pendingUserTurnEndedAt === null) {
      markUserTurnEnded(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    resetIdleTimer();
    if (fillerTimer) {
      clearTimeout(fillerTimer);
      fillerTimer = null;
    }
    if (runtime.behavior.autoFillResponses && event.newState === "thinking") {
      fillerTimer = setTimeout(() => {
        fillerTimer = null;
        if (session.agentState !== "thinking" || session.userState === "speaking") return;
        try {
          session.say("One moment while I check that.", {
            allowInterruptions: runtime.behavior.interruptions,
            addToChatCtx: false,
          });
        } catch (error) {
          console.error(JSON.stringify({
            event: "agent-filler-failed",
            room: roomName,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }, Math.max(900, Math.min(2500, runtime.behavior.responseDelayMs + 650)));
    }
    if (event.newState === "speaking") {
      recordLatency(event.createdAt);
    }
  });

  session.on(voice.AgentSessionEventTypes.SpeechCreated, () => {
    resetIdleTimer();
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

  return new Promise<void>((resolve) => {
    session.on(voice.AgentSessionEventTypes.Close, (event) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (fillerTimer) clearTimeout(fillerTimer);
      const write = event.error
        ? failCall(roomName, event.error).then(() => undefined)
        : completeCall(roomName, event.reason).then(() => undefined);
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
      const postCallTools = runPostCallTools(
        runtime,
        roomName,
        String(event.reason ?? (event.error ? JSON.stringify(event.error) : "call_closed")),
        Boolean(event.error),
      ).then(() => undefined);
      pendingWrites.add(postCallTools);
      void postCallTools.finally(() => pendingWrites.delete(postCallTools));
      void Promise.allSettled([...pendingWrites]).then(() => resolve());
    });
  });
}

function toolParameterSchema(parameters: ToolParameter[] = [], variables: Record<string, string> = {}): JSONSchema7 {
  if (!parameters.length) {
    return {
      type: "object",
      additionalProperties: true,
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        {
          type: parameter.type,
          description: replaceVariables(parameter.description, variables),
        },
      ]),
    ),
    required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    additionalProperties: false,
  };
}

type VoicemailState = { handled: boolean };

function webhookContext(runtime: AgentRuntime, roomName: string) {
  const variables = runtimeVariableMap(runtime, roomName);
  return {
    session_id: runtime.callId || roomName,
    call_id: runtime.callId,
    room_name: roomName,
    agent_id: runtime.agentId,
    owner_id: runtime.ownerId,
    call_direction: runtime.callDirection,
    caller_participant_identity: runtime.callerParticipantIdentity,
    from: variables.FromPhone,
    to: variables.ToPhone,
    from_phone: variables.FromPhone,
    to_phone: variables.ToPhone,
    timezone: variables.Timezone,
    current_date: variables.CurrentDate,
    current_time: variables.CurrentTime,
    current_day: variables.CurrentDay,
    metadata: runtime.metadata,
    variables,
  };
}

async function runPostCallTools(runtime: AgentRuntime, roomName: string, reason: string, failed: boolean) {
  const tools = runtime.tools.filter((tool) => tool.enabled && tool.runAfterCall);
  await Promise.allSettled(
    tools.map(async (tool) => {
      const result = await executeWebhookTool(
        tool,
        {
          reason,
          status: failed ? "failed" : "completed",
        },
        webhookContext(runtime, roomName),
      );
      if (!result.ok) {
        console.error(JSON.stringify({
          event: "post-call-tool-failed",
          tool: tool.name,
          room: roomName,
          status: result.status,
          responseText: result.responseText,
        }));
      }
    }),
  );
}

async function detectAnsweringMachine(
  session: voice.AgentSession,
  runtime: AgentRuntime,
  roomName: string,
  state: VoicemailState,
) {
  let amd: voice.AMD | null = null;
  try {
    amd = new voice.AMD(session, {
      participantIdentity: runtime.callerParticipantIdentity || undefined,
      interruptOnMachine: true,
      waitUntilFinished: true,
      noSpeechTimeoutMs: 8000,
      detectionTimeoutMs: 30000,
    });
    const prediction = await amd.execute();
    console.log(JSON.stringify({
      event: "answering-machine-detection",
      room: roomName,
      category: prediction.category,
      isMachine: prediction.isMachine,
      reason: prediction.reason,
      speechDurationMs: prediction.speechDurationMs,
      delayMs: prediction.delayMs,
    }));
    if (!prediction.isMachine) return true;
    if (state.handled) return false;

    state.handled = true;
    await markVoicemailDetected(roomName);
    if (runtime.behavior.voicemailAction === "leave-message" && runtime.behavior.voicemailMessage) {
      await session.say(runtime.behavior.voicemailMessage, {
        allowInterruptions: false,
        addToChatCtx: true,
      });
    }
    session.shutdown({ reason: "voicemail_detected" });
    return false;
  } catch (error) {
    console.error(JSON.stringify({
      event: "answering-machine-detection-failed",
      room: roomName,
      error: error instanceof Error ? error.message : String(error),
    }));
    return true;
  } finally {
    if (amd) await amd.aclose().catch(() => undefined);
  }
}

function createWebhookTools(
  runtime: AgentRuntime,
  roomName: string,
  session: voice.AgentSession,
  voicemailState: VoicemailState,
): llm.ToolContext {
  const speakToolFiller = (tool: AgentRuntime["tools"][number]) => {
    const participant = callerParticipant(session, runtime.callerParticipantIdentity);
    if (participant) syncRuntimeVariablesFromParticipant(runtime, participant);
    const variables = runtimeVariableMap(runtime, roomName);
    const messages = (tool.messages ?? []).map((message) => message.trim()).filter(Boolean);
    const message = messages.length ? messages[Math.floor(Math.random() * messages.length)] : "";
    if (!message) return undefined;
    return session.say(replaceVariables(message, variables), {
      allowInterruptions: true,
      addToChatCtx: true,
    }).then(() => undefined);
  };

  const customTools = Object.fromEntries(
    runtime.tools
      .filter((tool) => tool.enabled && !tool.runAfterCall)
      .map((tool) => [
        tool.name,
        llm.tool({
          description: replaceVariables(
            tool.description || `Call the ${tool.name} webhook.`,
            runtimeVariableMap(runtime, roomName),
          ),
          parameters: toolParameterSchema(tool.parameters, runtimeVariableMap(runtime, roomName)),
          execute: async (args) => {
            const participant = callerParticipant(session, runtime.callerParticipantIdentity);
            if (participant) syncRuntimeVariablesFromParticipant(runtime, participant);
            const variables = runtimeVariableMap(runtime, roomName);
            const filler = speakToolFiller(tool);
            if (tool.executeAfterMessage && filler) {
              await filler;
            } else {
              void filler?.catch((error) => {
                console.error(JSON.stringify({
                  event: "tool-filler-failed",
                  tool: tool.name,
                  room: roomName,
                  error: error instanceof Error ? error.message : String(error),
                }));
              });
            }
            const result = await executeWebhookTool(
              tool,
              resolveToolArgs(tool, args, variables),
              webhookContext(runtime, roomName),
            );
            if (!result.ok) throw new llm.ToolError(`${tool.name} returned HTTP ${result.status}: ${result.responseText}`);
            return result.responseText || `The ${tool.name} action completed successfully.`;
          },
        }),
      ]),
  );
  return {
    ...customTools,
    ...(runtime.knowledgeDocuments.length
      ? {
          search_knowledge_base: llm.tool({
            description: "Search the agent's approved knowledge base for facts before answering business, policy, service, FAQ, appointment, pricing, location, or document-specific questions.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The caller's factual question or the specific topic to search for.",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of snippets to return. Use 3 or 4 for normal questions.",
                },
              },
              required: ["query"],
              additionalProperties: false,
            },
            execute: async (args) => JSON.stringify(searchKnowledgeBase(
              runtime.knowledgeDocuments,
              String(args.query ?? ""),
              typeof args.limit === "number" ? args.limit : 4,
            )),
          }),
        }
      : {}),
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
    ...(runtime.behavior.agentCanTerminate
      ? {
          end_call: llm.tool({
            description: "End the current call after the caller is done, says goodbye, opts out, or asks to stop.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string", description: "Short reason for ending the call." },
              },
            },
            execute: async (args) => {
              const reason = String(args.reason ?? "agent_ended_call").slice(0, 120) || "agent_ended_call";
              session.shutdown({ reason });
              return JSON.stringify({ ended: true, reason });
            },
          }),
        }
      : {}),
    ...(runtime.behavior.voicemailHandling
      ? {
          voicemail_detected: llm.tool({
            description: "Mark that voicemail or an answering machine was reached, optionally leave the configured message, and end the call.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string", description: "What made this sound like voicemail." },
              },
            },
            execute: async (args) => {
              if (voicemailState.handled) {
                return JSON.stringify({ voicemailDetected: true, alreadyHandled: true });
              }
              voicemailState.handled = true;
              await markVoicemailDetected(roomName);
              if (runtime.behavior.voicemailAction === "leave-message" && runtime.behavior.voicemailMessage) {
                await session.say(runtime.behavior.voicemailMessage, {
                  allowInterruptions: false,
                  addToChatCtx: true,
                });
              }
              const reason = String(args.reason ?? "voicemail_detected").slice(0, 120) || "voicemail_detected";
              session.shutdown({ reason: "voicemail_detected" });
              return JSON.stringify({ voicemailDetected: true, reason, action: runtime.behavior.voicemailAction });
            },
          }),
        }
      : {}),
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

function applyPrefetchContext(runtime: AgentRuntime, context: string) {
  if (!context.trim()) return;
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      runtime.prompt = `${runtime.prompt}\n\nPrefetched call context:\n${context}`;
      return;
    }

    const metadata = objectRecord(parsed.metadata);
    runtime.metadata = { ...runtime.metadata, ...metadata };
    runtime.variables = { ...runtime.variables, ...metadata };

    const extraPrompt = typeof parsed.extra_prompt === "string"
      ? parsed.extra_prompt
      : typeof parsed.extraPrompt === "string" ? parsed.extraPrompt : "";
    if (extraPrompt.trim()) {
      runtime.prompt = `${runtime.prompt}\n\nPrefetched call context:\n${extraPrompt.trim()}`;
    }
  } catch {
    runtime.prompt = `${runtime.prompt}\n\nPrefetched call context:\n${context}`;
  }
}

async function applyPreviousCallerContext(runtime: AgentRuntime) {
  if (!runtime.callSettings.sessionContinuation && !runtime.callSettings.memoryEnabled) return;
  const context = await getPreviousCallerContext({
    ownerId: runtime.ownerId,
    agentId: runtime.agentId,
    callId: runtime.callId,
    callDirection: runtime.callDirection,
    fromPhone: runtime.fromPhone,
    toPhone: runtime.toPhone,
    metadata: runtime.metadata,
    includeMemory: runtime.callSettings.memoryEnabled,
    limit: runtime.callSettings.memoryEnabled ? 3 : 1,
  });
  if (!context.lines.length) return;

  runtime.variables.PreviousCallCount = String(context.previousCallCount);
  runtime.variables.PreviousCallerIdentifier = context.identifier;

  const heading = runtime.callSettings.memoryEnabled
    ? "Previous caller memory"
    : "Previous caller session history";
  const instruction = runtime.callSettings.memoryEnabled
    ? "Use this context to avoid making the caller repeat known information, but verify important facts before taking action."
    : "Use this only to recognize that the caller has contacted this agent before; ask for details again when needed.";

  runtime.prompt = [
    runtime.prompt,
    "",
    `${heading}:`,
    `- Caller identifier: ${context.identifier}`,
    `- Previous calls found: ${context.previousCallCount}`,
    ...context.lines,
    instruction,
  ].join("\n");
}

type ProcessData = { vad?: VAD };

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) {
  console.warn(JSON.stringify({
    event: "unsupported-node-version",
    expected: "22.x",
    actual: process.versions.node,
  }));
}

export default defineAgent({
  prewarm: async (proc: JobProcess<ProcessData>) => {
    const [vad] = await Promise.all([silero.VAD.load(), connectDatabase()]);
    proc.userData.vad = vad;
  },
  entry: async (ctx: JobContext<ProcessData>) => {
    const jobStartedAt = Date.now();
    await ctx.connect();

    const runtime = parseRuntime(ctx);
    const roomName = ctx.room.name ?? "unknown-room";
    try {
      await refreshRuntimeAgentData(runtime);
    } catch (error) {
      console.error(JSON.stringify({
        event: "runtime-agent-data-refresh-failed",
        room: roomName,
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    const initialCaller = [...ctx.room.remoteParticipants.values()].find(
      (participant) => participantKind(participant) !== ParticipantKind.AGENT,
    );
    if (initialCaller) syncRuntimeVariablesFromParticipant(runtime, initialCaller);
    await markCallActive(roomName, ctx.job.metadata || ctx.room.metadata);
    if (runtime.callSettings.recordingEnabled) {
      void startCallRecording(roomName, runtime.callId).catch((error) => {
        console.error(JSON.stringify({
          event: "call-recording-start-failed",
          room: roomName,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }
    try {
      await applyPreviousCallerContext(runtime);
    } catch (error) {
      console.error(JSON.stringify({
        event: "previous-caller-context-failed",
        room: roomName,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    if (runtime.prefetchWebhook) {
      const prefetchStartedAt = Date.now();
      try {
        const context = await callLifecycleWebhook(runtime.prefetchWebhook, {
          event: "call_started",
          callId: runtime.callId,
          roomName,
          agentId: runtime.agentId,
          ...webhookContext(runtime, roomName),
        }, 2000);
        applyPrefetchContext(runtime, context);
      } catch (error) {
        console.error(JSON.stringify({ event: "prefetch-webhook-failed", room: roomName, error: String(error) }));
      } finally {
        console.log(JSON.stringify({
          event: "prefetch-webhook-finished",
          room: roomName,
          elapsedMs: Date.now() - prefetchStartedAt,
        }));
      }
    }
    runtime.prompt = buildRuntimeInstructions(runtime, roomName);
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
        firstMessageMode: effectiveFirstMessageMode(runtime),
        callDirection: runtime.callDirection,
        callerParticipantIdentity: runtime.callerParticipantIdentity,
        elapsedMs: Date.now() - jobStartedAt,
      }),
    );
    const session =
      runtime.pipelineMode === "pipeline"
        ? createPipelineSession(runtime, ctx.proc.userData.vad ?? (await silero.VAD.load()))
        : createRealtimeSession(runtime);
    const trackingClosed = attachCallTracking(session, runtime, roomName);
    const voicemailState: VoicemailState = { handled: false };

    await session.start({
      agent: new Assistant(
        runtime.prompt,
        runtime.firstMessage,
        effectiveFirstMessageMode(runtime),
        runtime.callerParticipantIdentity,
        runtime,
        roomName,
        createWebhookTools(runtime, roomName, session, voicemailState),
        runtime.behavior.voicemailHandling && runtime.callDirection === "outbound"
          ? (activeSession) => detectAnsweringMachine(activeSession, runtime, roomName, voicemailState)
          : undefined,
      ),
      room: ctx.room,
      inputOptions: runtime.callerParticipantIdentity
        ? { participantIdentity: runtime.callerParticipantIdentity }
        : undefined,
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
        ...webhookContext(runtime, roomName),
      }).catch((error) => {
        console.error(JSON.stringify({ event: "end-call-webhook-failed", room: roomName, error: String(error) }));
      });
    });
    await trackingClosed;
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: env.livekitAgentName,
    numIdleProcesses: env.livekitAgentIdleProcesses,
    initializeProcessTimeout: env.livekitAgentInitializeTimeoutMs,
    shutdownProcessTimeout: env.livekitAgentShutdownTimeoutMs,
  }),
);
