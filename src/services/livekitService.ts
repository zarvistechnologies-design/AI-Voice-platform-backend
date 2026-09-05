import {
    AgentDispatch,
    JobStatus,
    ListUpdate,
    ParticipantInfo_Kind,
    RoomAgentDispatch,
    RoomConfiguration,
    SIPDispatchRule,
    SIPDispatchRuleIndividual,
    SIPDispatchRuleInfo,
    SIPHeaderOptions,
} from "@livekit/protocol";
import {
    AccessToken,
    AgentDispatchClient,
    EgressClient,
    EncodedFileOutput,
    EncodedFileType,
    RoomServiceClient,
    S3Upload,
    SipClient,
} from "livekit-server-sdk";

import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import type { VoiceAgentDocument } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import {
    createCallRecord,
    effectiveCallLanguage,
    effectiveModelSnapshot,
    failCall,
    updateCallParticipant,
    updateCallRecording,
} from "./callRecordService.js";
import {
    configuredModelCatalogSnapshot,
    normalizeElevenLabsTtsModel,
    normalizeGeminiLlmModel,
    normalizeGeminiRealtimeModel,
    normalizeGeminiTtsModel,
    normalizeOpenAIRealtimeModel,
    normalizeSarvamLlmModel,
    voiceLanguages,
} from "./modelCatalog.js";
import {
    missingPricingForStack,
    publishedTtsPricingForModel,
} from "./modelPricingService.js";
import {
    recordingPublicUrl,
    recordingS3ConfigError,
    recordingS3Configured,
} from "./recordingStorageService.js";
import { acquirePhoneNumberMutation } from "./phoneNumberMutationService.js";
import type { PhoneNumberCallAdmissionLease } from "./phoneNumberCallAdmissionService.js";
import {
  closeAndVerifyLiveKitRoom,
} from "./outboundSetupRecoveryService.js";

const openCallStatuses = ["initiated", "ringing", "active"];
const staleEmptyRoomMs = 90_000;

export function assertCallStackPriced(agent: VoiceAgentDocument) {
  const missing = missingPricingForStack({
    pipelineMode: agent.pipelineMode,
    realtimeProvider: agent.realtimeProvider,
    realtimeModel: normalizeRealtimeModelForAgent(agent),
    llmProvider: agent.llmProvider,
    llmModel: normalizeLlmModelForAgent(agent),
    sttProvider: agent.sttProvider,
    sttModel: agent.sttModel,
    ttsProvider: agent.ttsProvider,
    ttsModel: normalizeTtsModelForAgent(agent),
    language: effectiveCallLanguage(agent),
  });
  if (missing.length) {
    throw new HttpError(
      409,
      `Call blocked because exact pricing is missing for ${missing.map((item) => `${item.provider}/${item.model}`).join(", ")}.`,
    );
  }
}

function normalizeRealtimeModelForAgent(agent: VoiceAgentDocument) {
  if (agent.realtimeProvider === "gemini") {
    return normalizeGeminiRealtimeModel(agent.realtimeModel);
  }
  if (agent.realtimeProvider === "openai") {
    return normalizeOpenAIRealtimeModel(agent.realtimeModel);
  }
  return agent.realtimeModel;
}

function normalizeLlmModelForAgent(agent: VoiceAgentDocument) {
  if (agent.llmProvider === "gemini") return normalizeGeminiLlmModel(agent.llmModel);
  if (agent.llmProvider === "sarvam") return normalizeSarvamLlmModel(agent.llmModel);
  return agent.llmModel;
}

function normalizeTtsModelForAgent(agent: VoiceAgentDocument) {
  if (agent.ttsProvider === "gemini") return normalizeGeminiTtsModel(agent.ttsModel);
  if (agent.ttsProvider === "elevenlabs") return normalizeElevenLabsTtsModel(agent.ttsModel);
  return agent.ttsModel;
}

export type AgentDispatchHealth = {
  configured: boolean;
  roomName: string;
  dispatchId: string;
  agentName: string;
  region: string;
  state: "missing" | "waiting" | "pending" | "running" | "completed" | "failed" | "unknown";
  message: string;
  jobs: {
    id: string;
    status: "pending" | "running" | "success" | "failed" | "unknown";
    error: string;
    workerId: string;
    participantIdentity: string;
  }[];
};

export type AgentRuntimeSnapshot = {
  agentId: string;
  agentStatus: "Live" | "Draft" | "Paused";
  observedAt: string;
  dispatch: {
    state: AgentDispatchHealth["state"] | "idle";
    message: string;
    roomName: string;
    dispatchId: string;
    workerId: string;
  };
  region: string;
  activeCalls: number;
  maxConcurrentCalls: number;
  pipeline: {
    mode: "realtime" | "pipeline";
    label: string;
    stt: string;
  };
  latency: {
    latestMs: number | null;
    averageMs: number | null;
    sampleCount: number;
    measuredAt: string;
  };
  businessHours: {
    enabled: boolean;
    open: boolean;
    timezone: string;
  };
  phoneRoute: {
    number: string;
    provider: string;
    direction: "Inbound" | "Outbound" | "Both" | "";
    status: "Ready" | "Pending" | "Needs setup" | "Unassigned";
    inboundReady: boolean;
    outboundReady: boolean;
    totalCalls: number;
    activeCalls: number;
    completionRate: number | null;
  };
};

export const providerCatalog = [
  {
    id: "openai",
    label: "OpenAI",
    detail: "Realtime, LLM, speech-to-text, text-to-speech, and multiple voices.",
    configured: Boolean(env.openaiApiKey),
  },
  {
    id: "gemini",
    label: "Google Gemini",
    detail: "Gemini Live, LLM models, Gemini text-to-speech, and native voices.",
    configured: Boolean(env.googleApiKey),
  },
  {
    id: "sarvam",
    label: "Sarvam AI",
    detail: "Sarvam LLM, streaming speech-to-text, text-to-speech, and Indic voices.",
    configured: Boolean(env.sarvamApiKey),
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    detail: "ElevenLabs text-to-speech, speech-to-text, multilingual models, and voice previews.",
    configured: Boolean(env.elevenLabsApiKey),
  },
  {
    id: "deepgram",
    label: "Deepgram",
    detail: "Deepgram streaming speech-to-text with Flux, Nova, Enhanced, Base, and Whisper models.",
    configured: Boolean(env.deepgramApiKey),
  },
] as const;

function requireLiveKit() {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new HttpError(503, "LiveKit voice routing is not configured.");
  }
}

export function liveKitApiUrl() {
  return env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function apiUrl() {
  return liveKitApiUrl();
}

function readableRecordingError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function sanitizedRecordingPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 140);
}

function recordingKey(roomName: string, callId = "") {
  const prefix = env.livekitRecordingPrefix.trim().replace(/^\/+|\/+$/g, "") || "recordings";
  const name = sanitizedRecordingPart(callId || roomName || crypto.randomUUID());
  return `${prefix}/${name}-${Date.now()}.mp3`;
}

function recordingS3Output() {
  if (!env.livekitRecordingS3Bucket) return undefined;
  return {
    case: "s3" as const,
    value: new S3Upload({
      bucket: env.livekitRecordingS3Bucket,
      region: env.livekitRecordingS3Region,
      endpoint: env.livekitRecordingS3Endpoint,
      accessKey: env.livekitRecordingS3AccessKey,
      secret: env.livekitRecordingS3Secret,
      forcePathStyle: env.livekitRecordingS3ForcePathStyle,
    }),
  };
}

export async function startCallRecording(roomName: string, callId = "") {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    await updateCallRecording({
      roomName,
      status: "failed",
      error: "LiveKit is not configured, so recording could not start.",
    });
    return null;
  }

  if (!recordingS3Configured()) {
    await updateCallRecording({
      roomName,
      status: "failed",
      error: recordingS3ConfigError(),
    });
    return null;
  }

  const existing = await CallDetailRecordModel.findOne({ livekitRoomName: roomName })
    .select("recordingEgressId recordingStatus")
    .lean();
  if (existing?.recordingEgressId && ["starting", "active"].includes(existing.recordingStatus)) {
    return null;
  }

  const key = recordingKey(roomName, callId);
  const url = recordingPublicUrl(key);
  await updateCallRecording({ roomName, status: "starting", key, url });

  try {
    const egress = new EgressClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
    const file = new EncodedFileOutput({
      fileType: EncodedFileType.MP3,
      filepath: key,
      disableManifest: true,
      output: recordingS3Output(),
    });
    const info = await egress.startRoomCompositeEgress(roomName, file, { audioOnly: true });
    const result = info.fileResults[0] ?? (info.result.case === "file" ? info.result.value : undefined);
    const completedKey = result?.filename || key;
    await updateCallRecording({
      roomName,
      egressId: info.egressId,
      status: "active",
      key: completedKey,
      url: recordingPublicUrl(completedKey),
      durationSeconds: result ? Number(result.duration) / 1_000_000_000 : undefined,
    });
    return info;
  } catch (error) {
    await updateCallRecording({
      roomName,
      status: "failed",
      key,
      url,
      error: readableRecordingError(error),
    });
    return null;
  }
}

function inferredLiveKitSipUri() {
  if (env.livekitSipUri.trim()) return env.livekitSipUri.trim();
  try {
    const hostname = new URL(env.livekitUrl).hostname;
    if (hostname.endsWith(".livekit.cloud") && !hostname.endsWith(".sip.livekit.cloud")) {
      return `sip:${hostname.replace(/\.livekit\.cloud$/i, ".sip.livekit.cloud")}`;
    }
  } catch {
    return "";
  }
  return "";
}

function jobStatus(status: JobStatus | undefined): AgentDispatchHealth["jobs"][number]["status"] {
  if (status === JobStatus.JS_PENDING) return "pending";
  if (status === JobStatus.JS_RUNNING) return "running";
  if (status === JobStatus.JS_SUCCESS) return "success";
  if (status === JobStatus.JS_FAILED) return "failed";
  return "unknown";
}

function summarizeDispatch(
  dispatch: AgentDispatch | undefined,
  roomName: string,
  dispatchId = "",
  region = "",
): AgentDispatchHealth {
  const jobs =
    dispatch?.state?.jobs.map((job) => ({
      id: job.id,
      status: jobStatus(job.state?.status),
      error: job.state?.error ?? "",
      workerId: job.state?.workerId ?? "",
      participantIdentity: job.state?.participantIdentity ?? "",
    })) ?? [];

  const failedJob = jobs.find((job) => job.status === "failed");
  const runningJob = jobs.find((job) => job.status === "running");
  const pendingJob = jobs.find((job) => job.status === "pending");
  const completedJob = jobs.find((job) => job.status === "success");

  let state: AgentDispatchHealth["state"] = "unknown";
  let message = "LiveKit dispatch status is unknown. Check the agent worker logs.";

  if (!dispatch) {
    state = "missing";
    message = "No LiveKit agent dispatch was found for this room.";
  } else if (failedJob) {
    state = "failed";
    message = failedJob.error || "The LiveKit agent job failed. Check the backend agent worker logs.";
  } else if (runningJob) {
    state = "running";
    message = "The AI agent worker accepted this call.";
  } else if (pendingJob) {
    state = "pending";
    message = `LiveKit is waiting for an available "${env.livekitAgentName}" worker.`;
  } else if (completedJob) {
    state = "completed";
    message = "The LiveKit agent job already completed.";
  } else if (jobs.length === 0) {
    state = "waiting";
    message = `LiveKit created the dispatch but has not assigned it to "${env.livekitAgentName}" yet.`;
  }

  return {
    configured: Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret),
    roomName: dispatch?.room || roomName,
    dispatchId: dispatch?.id || dispatchId,
    agentName: dispatch?.agentName || env.livekitAgentName,
    region,
    state,
    message,
    jobs,
  };
}

function callDurationSeconds(startedAt: Date | null | undefined, endedAt: Date) {
  return startedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : 0;
}

function olderThan(date: Date | null | undefined, ageMs: number) {
  return Boolean(date && Date.now() - date.getTime() > ageMs);
}

function safeTimezone(timezone: string | undefined) {
  const candidate = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

export function runtimeMetadataForAgent(
  agent: VoiceAgentDocument,
  callId = "",
  options: {
    callDirection?: "web" | "inbound" | "outbound";
    callerParticipantIdentity?: string;
    fromPhone?: string;
    toPhone?: string;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const knowledgeSourceCount = Math.max(
    agent.knowledgeSourceCount ?? 0,
    agent.knowledgeDocuments.filter((document) => document.status === "ready").length,
  );
  const timezone = safeTimezone(agent.businessHours?.timezone || agent.behavior?.timezone);
  const metadata = options.metadata ?? {};
  const campaignGoal = typeof metadata.CampaignGoal === "string" ? metadata.CampaignGoal.slice(0, 2000) : "";
  const successCriteria = typeof metadata.SuccessCriteria === "string" ? metadata.SuccessCriteria.slice(0, 2000) : "";
  const consentRequired = metadata.ConsentOpeningRequired === true;
  const campaignInstructions = [
    campaignGoal ? `Campaign goal: ${campaignGoal}` : "",
    successCriteria ? `Success criteria: ${successCriteria}` : "",
    consentRequired
      ? "At the beginning of the call, clearly identify the organization and purpose of the call, then obtain permission to continue. If permission is declined, apologize, end the call, and treat it as an opt-out."
      : "",
  ].filter(Boolean).join("\n");
  const variables = {
    ...metadata,
    FromPhone: options.fromPhone ?? "",
    ToPhone: options.toPhone ?? "",
    CallId: callId,
    SessionId: callId,
    AgentId: agent.id,
    AgentName: agent.name,
    CallDirection: options.callDirection ?? "",
    Timezone: timezone,
  };
  const realtimeModel = normalizeRealtimeModelForAgent(agent);
  const llmModel = normalizeLlmModelForAgent(agent);
  const ttsModel = normalizeTtsModelForAgent(agent);

  return JSON.stringify({
    callId,
    callDirection: options.callDirection ?? "",
    callerParticipantIdentity: options.callerParticipantIdentity ?? "",
    fromPhone: options.fromPhone ?? "",
    toPhone: options.toPhone ?? "",
    metadata,
    variables,
    timezone,
    ownerId: agent.ownerId,
    agentId: agent.id,
    name: agent.name,
    knowledgeSourceCount,
    providerModel: agent.providerModel,
    pipelineMode: agent.pipelineMode,
    realtimeProvider: agent.realtimeProvider,
    realtimeModel,
    llmProvider: agent.llmProvider,
    llmModel,
    sttProvider: agent.sttProvider,
    sttModel: agent.sttModel,
    ttsProvider: agent.ttsProvider,
    ttsModel,
    ttsVoice: agent.voice,
    temperature: agent.temperature,
    voiceSpeed: agent.voiceSpeed,
    voicePitch: agent.voicePitch,
    interruptionSensitivity: agent.interruptionSensitivity,
    backgroundNoise: agent.backgroundNoise,
    prompt: [
      agent.prompt,
      knowledgeSourceCount
        ? "Approved knowledge retrieval is enabled. Use the retrieved source excerpts supplied for each caller question. Never invent a knowledge-base answer when no relevant excerpt is supplied."
        : "",
      campaignInstructions,
    ].filter(Boolean).join("\n\n"),
    firstMessage: agent.firstMessage,
    firstMessageMode: agent.firstMessageMode,
    language: agent.language,
    multilingualEnabled: agent.multilingualEnabled,
    languageSwitchingEnabled: agent.languageSwitchingEnabled,
    supportedLanguages: agent.supportedLanguages,
    voice: agent.voice,
    behavior: agent.behavior,
    callSettings: agent.callSettings,
    tools: agent.tools.filter((tool) => tool.enabled),
    analysisPlan: agent.analysisPlan,
    dynamicVariables: agent.dynamicVariables,
    prefetchWebhook: agent.prefetchWebhook,
    endOfCallWebhook: agent.endOfCallWebhook,
    googleCalendar: agent.googleCalendar,
    googleSheets: agent.googleSheets,
  });
}

function dispatchForAgent(
  agent: VoiceAgentDocument,
  callId = "",
  options: { callDirection?: "web" | "inbound" | "outbound"; callerParticipantIdentity?: string } = {},
) {
  return new RoomAgentDispatch({
    agentName: env.livekitAgentName,
    metadata: runtimeMetadataForAgent(agent, callId, options),
  });
}

function roomName(prefix: string, ownerId: string) {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12);
  return `${prefix}-${safeOwner}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function inboundRoomPrefix(number: string) {
  return `inbound-${number.replace(/\D/g, "")}-`;
}

function inboundNumberVariants(number: string) {
  const digits = number.replace(/\D/g, "");
  const variants = new Set([number, digits]);
  if (digits.startsWith("91") && digits.length === 12) {
    const national = digits.slice(2);
    variants.add(national);
    variants.add(`0${national}`);
  }
  return [...variants].filter(Boolean);
}

function canonicalInboundDispatchNumber(number: string) {
  return number.trim();
}

function inboundLocatorMetadataForAgent(
  agent: VoiceAgentDocument,
  number: string,
  routeMutationId: string,
) {
  // Inbound SIP rules are long-lived routing resources. Keep runtime agent
  // configuration out of LiveKit; the opaque mutation id only fences route
  // compensation. Load the complete, current agent from MongoDB per job.
  return JSON.stringify({
    ownerId: String(agent.ownerId),
    agentId: agent.id,
    callDirection: "inbound",
    toPhone: number,
    routeMutationId,
  });
}

function inboundRouteInfo(
  agent: VoiceAgentDocument,
  number: string,
  trunkId: string,
  routeMutationId: string,
) {
  const metadata = inboundLocatorMetadataForAgent(agent, number, routeMutationId);
  return new SIPDispatchRuleInfo({
    rule: new SIPDispatchRule({
      rule: {
        case: "dispatchRuleIndividual",
        value: new SIPDispatchRuleIndividual({ roomPrefix: inboundRoomPrefix(number) }),
      },
    }),
    name: `${agent.name} - ${number}`,
    trunkIds: [trunkId],
    metadata,
    hidePhoneNumber: false,
    roomConfig: new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: env.livekitAgentName, metadata })],
      departureTimeout: 30,
    }),
  });
}

function routeRoomPrefix(route: SIPDispatchRuleInfo) {
  const rule = route.rule?.rule;
  return rule?.case === "dispatchRuleIndividual" ? rule.value.roomPrefix : "";
}

function routeMatchesNumber(route: SIPDispatchRuleInfo, number: string) {
  const roomPrefix = inboundRoomPrefix(number);
  const canonical = canonicalInboundDispatchNumber(number);
  const variants = inboundNumberVariants(number);
  const scopedNumbers = [...route.inboundNumbers, ...route.numbers];
  const scopedToNumber = scopedNumbers.includes(canonical) || variants.some((variant) => scopedNumbers.includes(variant));
  const roomPrefixForNumber =
    route.inboundNumbers.length === 0 &&
    route.numbers.length === 0 &&
    routeRoomPrefix(route) === roomPrefix;
  return scopedToNumber || roomPrefixForNumber;
}

function routeMetadata(route: SIPDispatchRuleInfo) {
  try {
    return JSON.parse(route.metadata || "{}") as {
      ownerId?: unknown;
      routeMutationId?: unknown;
    };
  } catch {
    return {};
  }
}

function routeOwnerId(route: SIPDispatchRuleInfo) {
  const ownerId = routeMetadata(route).ownerId;
  return typeof ownerId === "string" ? ownerId : "";
}

function routeMutationId(route: SIPDispatchRuleInfo) {
  const mutationId = routeMetadata(route).routeMutationId;
  return typeof mutationId === "string" ? mutationId : "";
}

function routeHasScopedNumbers(route: SIPDispatchRuleInfo) {
  return route.inboundNumbers.length > 0 || route.numbers.length > 0;
}

type SipInboundTrunk = Awaited<ReturnType<SipClient["listSipInboundTrunk"]>>[number];

function isE164Number(value: string) {
  return /^\+\d{7,15}$/.test(value);
}

function trunkE164Numbers(trunk: SipInboundTrunk) {
  return trunk.numbers.filter(isE164Number);
}

function isRouteCompatibleWithNumberTrunk(
  route: SIPDispatchRuleInfo,
  trunkById: Map<string, SipInboundTrunk>,
) {
  if (route.trunkIds.length === 0) return false;
  const roomPrefix = routeRoomPrefix(route);
  return route.trunkIds.every((trunkId) => {
    const trunk = trunkById.get(trunkId);
    if (!trunk || trunk.numbers.includes("*")) return false;
    const e164s = trunkE164Numbers(trunk);
    return e164s.length === 1 && roomPrefix === inboundRoomPrefix(e164s[0]);
  });
}

function isLegacyPlatformWildcardRoute(
  route: SIPDispatchRuleInfo,
  trunkById: Map<string, SipInboundTrunk>,
) {
  // Routes created by this platform carry an owner id. Never delete another
  // managed number's route merely because its trunk currently accepts `*`.
  if (routeOwnerId(route)) return false;
  if (routeHasScopedNumbers(route)) return false;
  const roomPrefix = routeRoomPrefix(route);
  if (!roomPrefix.startsWith("inbound-")) return false;
  if (isRouteCompatibleWithNumberTrunk(route, trunkById)) return false;
  const agentNames = route.roomConfig?.agents?.map((agent) => agent.agentName).filter(Boolean) ?? [];
  return agentNames.length === 0 || agentNames.includes(env.livekitAgentName);
}

async function deleteLegacyWildcardRules(
  sip: SipClient,
  routes: SIPDispatchRuleInfo[],
  trunkById: Map<string, SipInboundTrunk>,
) {
  for (const route of routes) {
    if (!isLegacyPlatformWildcardRoute(route, trunkById)) continue;
    await sip.deleteSipDispatchRule(route.sipDispatchRuleId);
  }
}

async function createInboundDispatchRule(sip: SipClient, route: SIPDispatchRuleInfo) {
  const roomPrefix = routeRoomPrefix(route);
  if (!roomPrefix) throw new HttpError(500, "Inbound route is missing a room prefix.");
  return sip.createSipDispatchRule(
    { type: "individual", roomPrefix },
    {
      trunkIds: route.trunkIds,
      hidePhoneNumber: false,
      name: route.name,
      metadata: route.metadata,
      attributes: route.attributes,
      roomPreset: route.roomPreset,
      roomConfig: route.roomConfig,
    },
  );
}

function hasInboundAgentDispatch(route: SIPDispatchRuleInfo) {
  return Boolean(
    route.roomConfig?.agents?.some((agent) => agent.agentName === env.livekitAgentName),
  );
}

async function ensureInboundAgentDispatch(sip: SipClient, route: SIPDispatchRuleInfo) {
  if (hasInboundAgentDispatch(route)) return route;
  if (!route.sipDispatchRuleId) {
    throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
  }

  const roomConfig = route.roomConfig ?? new RoomConfiguration();
  roomConfig.departureTimeout = roomConfig.departureTimeout || 30;
  roomConfig.agents = [
    new RoomAgentDispatch({
      agentName: env.livekitAgentName,
      metadata: route.metadata,
    }),
  ];
  route.roomConfig = roomConfig;

  const repaired = await sip.updateSipDispatchRule(route.sipDispatchRuleId, route);
  if (!hasInboundAgentDispatch(repaired)) {
    throw new HttpError(502, "LiveKit inbound rule was saved without an agent dispatch.");
  }
  return repaired;
}

export function outboundTrunkIdForProvider(provider: string, storedTrunkId = "") {
  if (provider.trim().toLowerCase() === "exotel") {
    return env.exotelSipOutboundTrunkId;
  }
  return storedTrunkId || env.livekitSipOutboundTrunkId;
}

async function ensureOutboundCallerId(
  sip: SipClient,
  fromNumber: string,
  outboundTrunkId: string,
  provider: string,
) {
  const [trunk] = await sip.listSipOutboundTrunk({
    trunkIds: [outboundTrunkId],
  });
  if (!trunk) {
    throw new HttpError(503, "Configured outbound SIP trunk was not found in LiveKit.");
  }
  if (provider.trim().toLowerCase() === "vobiz" && trunk.name !== env.vobizOutboundTrunkName) {
    await sip.updateSipOutboundTrunkFields(outboundTrunkId, {
      name: env.vobizOutboundTrunkName,
    });
  }
  if (trunk.numbers.length === 0 || trunk.numbers.includes("*") || trunk.numbers.includes(fromNumber)) {
    return;
  }

  await sip.updateSipOutboundTrunkFields(outboundTrunkId, {
    numbers: new ListUpdate({ add: [fromNumber] }),
  });
}

function inboundAllowedAddresses() {
  return ["0.0.0.0/0"];
}

const inboundCallerHeaderAttributes = {
  From: "sip.from",
  To: "sip.to",
  "P-Asserted-Identity": "sip.pAssertedIdentity",
  "P-Preferred-Identity": "sip.pPreferredIdentity",
  "Remote-Party-ID": "sip.remotePartyId",
  Diversion: "sip.diversion",
};

async function ensureInboundCallerHeaderCapture(sip: SipClient, trunk: SipInboundTrunk) {
  const headersToAttributes = {
    ...trunk.headersToAttributes,
    ...inboundCallerHeaderAttributes,
  };
  const needsHeaderCapture =
    trunk.includeHeaders !== SIPHeaderOptions.SIP_ALL_HEADERS ||
    Object.entries(inboundCallerHeaderAttributes).some(([header, attribute]) => trunk.headersToAttributes[header] !== attribute);
  if (!needsHeaderCapture) return trunk;
  trunk.includeHeaders = SIPHeaderOptions.SIP_ALL_HEADERS;
  trunk.headersToAttributes = headersToAttributes;
  return sip.updateSipInboundTrunk(trunk.sipTrunkId, trunk);
}

function numberInboundTrunkName(phoneNumber: string) {
  return `${env.vobizInboundTrunkName} ${phoneNumber}`;
}

function numberInboundTrunkMetadata(phoneNumber: string) {
  return JSON.stringify({ managedBy: "ai-voice-platform", phoneNumber });
}

function managedTrunkPhoneNumber(trunk: SipInboundTrunk) {
  try {
    const metadata = JSON.parse(trunk.metadata || "{}") as Record<string, unknown>;
    return metadata.managedBy === "ai-voice-platform" && typeof metadata.phoneNumber === "string"
      ? metadata.phoneNumber
      : "";
  } catch {
    return "";
  }
}

function isManagedNumberTrunk(trunk: SipInboundTrunk) {
  return (
    trunk.name.startsWith("Voice Platform +")
    || trunk.name.startsWith(`${env.vobizInboundTrunkName} +`)
    || Boolean(managedTrunkPhoneNumber(trunk))
  );
}

function isTrunkDedicatedToNumber(trunk: SipInboundTrunk, variants: Set<string>) {
  return (
    !trunk.numbers.includes("*") &&
    trunk.numbers.length > 0 &&
    trunk.numbers.every((number) => variants.has(number))
  );
}

async function ensureNumberInboundTrunk(sip: SipClient, phoneNumber: string) {
  const variants = inboundNumberVariants(phoneNumber);
  const variantSet = new Set(variants);
  const trunks = await sip.listSipInboundTrunk();
  const existing =
    trunks.find((trunk) => managedTrunkPhoneNumber(trunk) === phoneNumber) ??
    trunks.find((trunk) => trunk.name === numberInboundTrunkName(phoneNumber)) ??
    trunks.find((trunk) => isTrunkDedicatedToNumber(trunk, variantSet));

  if (existing) {
    await cleanUpNumberInboundTrunks(sip, trunks, existing.sipTrunkId, phoneNumber);
    const brandedName = numberInboundTrunkName(phoneNumber);
    if (existing.name !== brandedName) {
      await sip.updateSipInboundTrunkFields(existing.sipTrunkId, { name: brandedName });
      existing.name = brandedName;
    }
    const missing = variants.filter((number) => !existing.numbers.includes(number));
    const removeWildcard = existing.numbers.includes("*");
    const missingAllowedAddresses = inboundAllowedAddresses().filter(
      (address) => !existing.allowedAddresses.includes(address),
    );
    if (missing.length > 0 || removeWildcard) {
      await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
        numbers: new ListUpdate({
          add: missing,
          remove: removeWildcard ? ["*"] : [],
        }),
      });
      existing.numbers = [...existing.numbers.filter((number) => number !== "*"), ...missing];
    }
    if (missingAllowedAddresses.length > 0) {
      await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
        allowedAddresses: new ListUpdate({ add: missingAllowedAddresses }),
      });
      existing.allowedAddresses.push(...missingAllowedAddresses);
    }
    return ensureInboundCallerHeaderCapture(sip, existing);
  }

  // LiveKit rejects overlapping unauthenticated trunks. Split this DID out of
  // a legacy shared trunk before creating its dedicated route, and restore it
  // if creation fails.
  const changedTrunks: { id: string; removed: string[] }[] = [];
  for (const trunk of trunks) {
    if (trunk.numbers.includes("*")) continue;
    const removed = trunk.numbers.filter((number) => variantSet.has(number));
    if (removed.length === 0) continue;
    const remaining = trunk.numbers.filter((number) => !variantSet.has(number));
    if (remaining.length === 0) continue;
    await sip.updateSipInboundTrunkFields(trunk.sipTrunkId, {
      numbers: new ListUpdate({ remove: removed }),
    });
    changedTrunks.push({ id: trunk.sipTrunkId, removed });
  }

  try {
    return await sip.createSipInboundTrunk(
      numberInboundTrunkName(phoneNumber),
      variants,
      {
        metadata: numberInboundTrunkMetadata(phoneNumber),
        allowedAddresses: inboundAllowedAddresses(),
        includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS,
        headersToAttributes: inboundCallerHeaderAttributes,
      },
    );
  } catch (error) {
    for (const changed of changedTrunks) {
      await sip.updateSipInboundTrunkFields(changed.id, {
        numbers: new ListUpdate({ add: changed.removed }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function cleanUpNumberInboundTrunks(
  sip: SipClient,
  trunks: SipInboundTrunk[],
  keepTrunkId: string,
  phoneNumber: string,
) {
  const variants = new Set(inboundNumberVariants(phoneNumber));
  for (const trunk of trunks) {
    if (trunk.sipTrunkId === keepTrunkId || trunk.numbers.includes("*")) continue;
    const toRemove = trunk.numbers.filter((number) => variants.has(number));
    if (toRemove.length === 0) continue;
    const remaining = trunk.numbers.filter((number) => !variants.has(number));
    if (remaining.length === 0 && isManagedNumberTrunk(trunk)) {
      await sip.deleteSipTrunk(trunk.sipTrunkId);
      continue;
    }
    if (remaining.length > 0) {
      await sip.updateSipInboundTrunkFields(trunk.sipTrunkId, {
        numbers: new ListUpdate({ remove: toRemove }),
      });
    }
  }
}

export async function livekitConfiguration() {
  const catalogSnapshot = configuredModelCatalogSnapshot();
  const ttsModelPricing = Object.fromEntries(
    catalogSnapshot.value.tts.flatMap((provider) =>
      provider.models.flatMap((model) => {
        const pricing = publishedTtsPricingForModel(provider.provider, model);
        return pricing ? [[pricing.key, pricing] as const] : [];
      }),
    ),
  );
  return {
    configured: Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret),
    url: env.livekitUrl,
    agentName: env.livekitAgentName,
    sip: {
      // Inbound trunks are created per DID when an agent is linked.
      inboundConfigured: Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret),
      outboundConfigured: Boolean(
        env.livekitSipOutboundTrunkId || env.exotelSipOutboundTrunkId,
      ),
      inboundDestinationConfigured: Boolean(inferredLiveKitSipUri()),
      callerId: "",
    },
    providers: providerCatalog,
    languageCatalog: voiceLanguages,
    modelCatalog: catalogSnapshot.value,
    modelCatalogReady: catalogSnapshot.ready,
    pricing: {
      currency: "USD",
      telephonyPerMinute: 0,
      inrPerUsd: env.costRates.inrPerUsd,
      platformFeeInrPerMinute: env.costRates.platformFeeInrPerMinute,
      markupMultiplier: 1,
      ttsModels: ttsModelPricing,
    },
    latencyGuide: {
      realtime: { openai: 650, gemini: 750 },
      llm: { openai: 600, gemini: 700, sarvam: 850 },
      stt: { openai: 320, sarvam: 450, deepgram: 280 },
      tts: { openai: 420, gemini: 450, sarvam: 380 },
      telephony: 120,
    },
  };
}

export async function reconcileOpenCallRecordsForAgent(agent: VoiceAgentDocument) {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) return;

  const openCalls = await CallDetailRecordModel.find({
    ownerId: agent.ownerId,
    agentId: agent._id,
    status: { $in: openCallStatuses },
  })
    .select("_id livekitRoomName status startedAt createdAt updatedAt outboundSetupPending")
    .lean();
  if (openCalls.length === 0) return;

  try {
    const rooms = new RoomServiceClient(
      apiUrl(),
      env.livekitApiKey,
      env.livekitApiSecret,
      { requestTimeout: 5 },
    );
    const liveRooms = await rooms.listRooms(openCalls.map((call) => call.livekitRoomName));
    const liveRoomByName = new Map(liveRooms.map((room) => [room.name, room]));
    let closed = 0;

    for (const call of openCalls) {
      // Setup-pending outbound calls are protected by a durable mutation
      // guard. Only the exact setup owner may clear it after verified cleanup;
      // treating it as stale here could authorize deletion under a paused job.
      if (call.outboundSetupPending) continue;
      const liveRoom = liveRoomByName.get(call.livekitRoomName);
      const staleByAge = olderThan(call.updatedAt ?? call.createdAt, staleEmptyRoomMs);
      const emptyTooLong =
        liveRoom &&
        Number(liveRoom.numParticipants ?? 0) === 0 &&
        staleByAge;

      // A missed participant-left webhook can leave the room alive with only
      // the agent. Prove the outbound SIP customer is gone before closing it.
      // The age guard is longer than the normal 30-second ringing timeout, so
      // an in-progress dial cannot be mistaken for an orphaned call.
      let outboundCallerMissing = false;
      if (
        liveRoom
        && Number(liveRoom.numParticipants ?? 0) <= 1
        && staleByAge
        && call.livekitRoomName.startsWith("outbound-call-")
      ) {
        const participants = await rooms.listParticipants(call.livekitRoomName).catch((error) => {
          console.error(JSON.stringify({
            event: "stale-outbound-call-participants-read-failed",
            room: call.livekitRoomName,
            error: error instanceof Error ? error.message : String(error),
          }));
          return null;
        });
        outboundCallerMissing = Boolean(participants && !participants.some((participant) =>
          participant.kind === ParticipantInfo_Kind.SIP || participant.identity.startsWith("phone-"),
        ));
      }

      if (liveRoom && !emptyTooLong && !outboundCallerMissing) continue;

      if (liveRoom) {
        await rooms.deleteRoom(call.livekitRoomName).catch(() => undefined);
      }

      const reason = !liveRoom
        ? "stale_missing_livekit_room"
        : outboundCallerMissing
          ? "stale_outbound_caller_missing"
          : "stale_empty_livekit_room";
      const message = !liveRoom
        ? "LiveKit room no longer exists while call record was still open."
        : outboundCallerMissing
          ? "Outbound LiveKit room no longer contained its SIP caller while the call record was still open."
          : "LiveKit room stayed empty while call record was still open.";
      const terminal = await failCall(call.livekitRoomName, message, reason);
      if (terminal?.status === "failed") closed += 1;
    }

    if (closed > 0) {
      console.log(JSON.stringify({ event: "stale-open-calls-closed", agentId: agent.id, closed }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "stale-open-call-reconcile-failed",
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function createWebCallToken(
  agent: VoiceAgentDocument,
  ownerId: string,
  options: {
    participantName?: string;
    metadata?: Record<string, unknown>;
    callerParticipantIdentity?: string;
  } = {},
) {
  requireLiveKit();
  assertCallStackPriced(agent);
  const name = roomName("web-call", ownerId);
  const call = await createCallRecord({
    ownerId,
    agentId: agent._id,
    livekitRoomName: name,
    direction: "web",
    ...effectiveModelSnapshot({
      pipelineMode: agent.pipelineMode,
      realtimeProvider: agent.realtimeProvider,
      realtimeModel: normalizeRealtimeModelForAgent(agent),
      language: agent.language,
      multilingualEnabled: agent.multilingualEnabled,
      llmProvider: agent.llmProvider,
      llmModel: normalizeLlmModelForAgent(agent),
      sttProvider: agent.sttProvider,
      sttModel: agent.sttModel,
      ttsProvider: agent.ttsProvider,
      ttsModel: normalizeTtsModelForAgent(agent),
      ttsVoice: agent.voice,
    }),
  });
  const participantIdentity = options.callerParticipantIdentity || `web-${crypto.randomUUID()}`;
  const metadata = runtimeMetadataForAgent(agent, call.id, {
    callDirection: "web",
    callerParticipantIdentity: participantIdentity,
    metadata: options.metadata,
  });
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const dispatch = new AgentDispatchClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  try {
    await rooms.createRoom({
      name,
      emptyTimeout: 60,
      departureTimeout: 30,
      metadata,
    });
    const agentDispatch = await dispatch.createDispatch(name, env.livekitAgentName, { metadata });
    await CallDetailRecordModel.updateOne(
      { livekitRoomName: name },
      { $set: { livekitDispatchId: agentDispatch.id } },
    );
    const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
      identity: participantIdentity,
      name: options.participantName || "Website visitor",
      metadata,
      ttl: "15m",
    });

    token.addGrant({
      roomJoin: true,
      room: name,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    token.roomConfig = new RoomConfiguration({
      emptyTimeout: 60,
      departureTimeout: 30,
    });

    return {
      callId: call.id,
      roomName: name,
      dispatchId: agentDispatch.id,
      dispatch: summarizeDispatch(agentDispatch, name),
      serverUrl: env.livekitUrl,
      participantToken: await token.toJwt(),
    };
  } catch (error) {
    await failCall(name, error);
    throw error;
  }
}

export async function getAgentDispatchHealth(roomName: string, dispatchId = "") {
  requireLiveKit();
  const dispatchClient = new AgentDispatchClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const [dispatch, participants] = await Promise.all([
    dispatchId
      ? dispatchClient.getDispatch(dispatchId, roomName)
      : dispatchClient.listDispatch(roomName).then((items) =>
          items.find((item) => item.agentName === env.livekitAgentName),
        ),
    rooms.listParticipants(roomName).catch(() => []),
  ]);
  const region = participants.find((participant) => participant.region)?.region ?? "";
  return summarizeDispatch(dispatch, roomName, dispatchId, region);
}

export async function refreshCallParticipantNumbers(roomName: string) {
  requireLiveKit();
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const participants = await rooms.listParticipants(roomName);
  await Promise.all(
    participants
      .filter((participant) => participant.kind !== 4)
      .map((participant) => updateCallParticipant(roomName, participant)),
  );
}

export async function startOutboundCall(
  agent: VoiceAgentDocument,
  ownerId: string,
  destination: string,
  fromNumber: string,
  options: {
    phoneNumberId: string;
    callAdmission: PhoneNumberCallAdmissionLease;
    campaignId?: string;
    campaignLeadId?: string;
    metadata?: Record<string, unknown>;
    telephonyProvider?: string;
    outboundTrunkId?: string;
    onCallCreated?: (callId: string) => Promise<void> | void;
  },
) {
  requireLiveKit();
  assertCallStackPriced(agent);
  const telephonyProvider = options.telephonyProvider ?? "";
  const outboundTrunkId = outboundTrunkIdForProvider(
    telephonyProvider,
    options.outboundTrunkId,
  );
  if (!outboundTrunkId) {
    const providerLabel = telephonyProvider || "selected provider";
    throw new HttpError(503, `Outbound SIP routing is not configured for ${providerLabel}.`);
  }

  const name = roomName("outbound-call", ownerId);
  let call: Awaited<ReturnType<typeof createCallRecord>> | null = null;
  let setupToken = "";
  let roomCreationAttempted = false;
  let dialAttempted = false;
  try {
    const admittedPhone = options.callAdmission.phone;
    if (
      String(admittedPhone._id) !== String(options.phoneNumberId)
      || String(admittedPhone.agentId ?? "") !== String(agent._id)
      || admittedPhone.number !== fromNumber
      || admittedPhone.status !== "Ready"
      || !["Outbound", "Both"].includes(admittedPhone.direction)
    ) {
      throw new HttpError(409, "The outbound call admission no longer matches a ready caller ID.");
    }
    call = await options.callAdmission.linearizeCallStart((session, currentSetupToken) => {
      setupToken = currentSetupToken;
      return createCallRecord({
        ownerId,
        agentId: agent._id,
        livekitRoomName: name,
        direction: "outbound",
        callerNumber: fromNumber,
        calledNumber: destination,
        phoneNumberId: options.phoneNumberId,
        campaignId: options.campaignId,
        campaignLeadId: options.campaignLeadId,
        outboundSetupPending: true,
        outboundSetupToken: currentSetupToken,
        outboundSetupStage: "starting",
        outboundSetupStartedAt: new Date(),
        ...effectiveModelSnapshot({
          pipelineMode: agent.pipelineMode,
          realtimeProvider: agent.realtimeProvider,
          realtimeModel: normalizeRealtimeModelForAgent(agent),
          language: agent.language,
          multilingualEnabled: agent.multilingualEnabled,
          llmProvider: agent.llmProvider,
          llmModel: normalizeLlmModelForAgent(agent),
          sttProvider: agent.sttProvider,
          sttModel: agent.sttModel,
          ttsProvider: agent.ttsProvider,
          ttsModel: normalizeTtsModelForAgent(agent),
          ttsVoice: agent.voice,
        }),
      }, { session });
    });

    const fenceSetupStage = async (
      stage: "preparing" | "room_creating" | "room_created" | "dispatch_created" | "dialing" | "established",
      extra: Record<string, unknown> = {},
    ) => {
      if (!call) throw new Error("The outbound call record is not available.");
      await options.callAdmission.fenceCallStep(async (session, currentSetupToken) => {
        const updated = await CallDetailRecordModel.updateOne(
          {
            _id: call!._id,
            ownerId,
            phoneNumberId: options.phoneNumberId,
            direction: "outbound",
            status: { $in: openCallStatuses },
            outboundSetupPending: true,
            outboundSetupToken: currentSetupToken,
          },
          { $set: { outboundSetupStage: stage, ...extra } },
          { session },
        );
        if (updated.matchedCount !== 1) {
          throw new HttpError(409, "Outbound call setup was cancelled or superseded before dialing.");
        }
      });
    };

    await options.onCallCreated?.(call.id);
    await fenceSetupStage("preparing");
    const participantIdentity = `phone-${destination.replace(/\D/g, "")}-${Date.now()}`;
    const metadata = runtimeMetadataForAgent(agent, call.id, {
      callDirection: "outbound",
      callerParticipantIdentity: participantIdentity,
      fromPhone: fromNumber,
      toPhone: destination,
      metadata: options.metadata,
    });
    const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
    const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
    const dispatch = new AgentDispatchClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
    const startedAt = Date.now();
    await ensureOutboundCallerId(sip, fromNumber, outboundTrunkId, telephonyProvider);

    await fenceSetupStage("room_creating");
    roomCreationAttempted = true;
    await rooms.createRoom({
      name,
      emptyTimeout: 60,
      departureTimeout: 30,
      metadata,
    });
    console.log(JSON.stringify({ event: "outbound-room-created", callId: call.id, room: name, elapsedMs: Date.now() - startedAt }));
    await fenceSetupStage("room_created");

    const agentDispatch = await dispatch.createDispatch(name, env.livekitAgentName, { metadata });
    await fenceSetupStage("dispatch_created", { livekitDispatchId: agentDispatch.id });
    console.log(JSON.stringify({ event: "outbound-agent-dispatched", callId: call.id, room: name, elapsedMs: Date.now() - startedAt }));

    await fenceSetupStage("dialing");
    // Keep this final renewal adjacent to the non-transactional SIP side
    // effect. The durable CDR guard still blocks mutation if this process is
    // suspended after the check.
    await options.callAdmission.assertHeld();
    dialAttempted = true;
    const participant = await sip.createSipParticipant(
      outboundTrunkId,
      destination,
      name,
      {
        fromNumber,
        participantIdentity,
        participantName: destination,
        participantMetadata: metadata,
        waitUntilAnswered: true,
        playDialtone: true,
        krispEnabled: true,
        ringingTimeout: 30,
        maxCallDuration: agent.behavior?.maxCallDurationSeconds ?? 1200,
        dtmf: agent.behavior?.dtmfDial ? agent.behavior?.dtmfSequence : undefined,
      },
    );
    console.log(JSON.stringify({ event: "outbound-sip-participant-created", callId: call.id, room: name, elapsedMs: Date.now() - startedAt }));

    await fenceSetupStage("established", {
      livekitParticipantId: participant.participantId,
      outboundSetupPending: false,
      outboundSetupToken: "",
      outboundSetupCompletedAt: new Date(),
    });

    const participants = await rooms.listParticipants(name).catch(() => []);
    const region = participants.find((item) => item.region)?.region ?? "";

    return {
      callId: call.id,
      roomName: name,
      participantId: participant.participantId,
      dispatchId: agentDispatch.id,
      dispatch: summarizeDispatch(agentDispatch, name, agentDispatch.id, region),
    };
  } catch (error) {
    const roomCleanupVerified = !roomCreationAttempted || await closeAndVerifyLiveKitRoom(name);
    let setupGuardResolved = !call || !setupToken;
    if (call && setupToken) {
      const setupUpdate = await CallDetailRecordModel.updateOne(
        {
          _id: call._id,
          ownerId,
          outboundSetupPending: true,
          outboundSetupToken: setupToken,
        },
        {
          $set: {
            outboundSetupStage: roomCleanupVerified ? "aborted" : "cleanup_required",
            ...(!roomCleanupVerified
              ? { errorMessage: `Outbound setup failed; room cleanup is unverified: ${error instanceof Error ? error.message : String(error)}` }
              : {}),
            ...(roomCleanupVerified
              ? {
                  outboundSetupPending: false,
                  outboundSetupToken: "",
                  outboundSetupCompletedAt: new Date(),
                }
              : {}),
          },
        },
      ).catch((setupError) => {
        console.error(JSON.stringify({
          event: "outbound-call-setup-guard-update-failed",
          callId: call?.id ?? "",
          room: name,
          error: setupError instanceof Error ? setupError.message : String(setupError),
        }));
        return null;
      });
      setupGuardResolved = Boolean(roomCleanupVerified && setupUpdate?.matchedCount === 1);
    }
    if (roomCleanupVerified && setupGuardResolved) {
      await failCall(name, error).catch((recordError) => {
        console.error(JSON.stringify({
          event: "outbound-call-failure-record-update-failed",
          room: name,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        }));
      });
    }
    if (!roomCleanupVerified || !setupGuardResolved) {
      console.error(JSON.stringify({
        event: "outbound-call-room-cleanup-unverified",
        callId: call?.id ?? "",
        room: name,
        originalError: error instanceof Error ? error.message : String(error),
      }));
      throw new HttpError(
        503,
        roomCleanupVerified
          ? "Outbound setup stopped safely, but its durable guard needs operator repair. The phone number remains locked."
          : "Outbound setup failed and its LiveKit room could not be verified closed. The phone number remains safely locked for repair.",
      );
    }
    const dialMessage = error instanceof Error ? error.message : String(error);
    if (
      dialAttempted
      && /(?:\b403\b|forbidden|geo(?:graphic)?\s*permissions?|international.*(?:disabled|not enabled|not permitted)|destination.*(?:blocked|not allowed|not permitted|unsupported)|country.*(?:blocked|not allowed|not permitted|unsupported))/i.test(dialMessage)
    ) {
      throw new HttpError(
        502,
        `The ${telephonyProvider || "telephony"} provider rejected this destination. Enable international or geographic calling for the destination country in the provider account, then retry.`,
      );
    }
    throw error;
  }
}

export async function endCallRooms(roomNames: string[]) {
  if (!roomNames.length) return [];
  requireLiveKit();
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const failed = await Promise.all(roomNames.map(async (name) => {
    for (const delay of [0, 200, 750] as const) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await rooms.deleteRoom(name).catch(() => undefined);
      // A successful DeleteRoom response is not sufficient proof for releasing
      // a terminal-finalization deferral. Always read back room absence.
      const stillExists = await rooms.listRooms([name])
        .then((items) => items.some((item) => item.name === name))
        .catch(() => true);
      if (!stillExists) return "";
    }
    return name;
  }));
  return failed.filter(Boolean);
}

export async function transferSipCall(roomName: string, destination: string) {
  requireLiveKit();
  if (!env.livekitSipOutboundTrunkId) {
    throw new HttpError(503, "Configure a LiveKit outbound SIP trunk before using human handoff.");
  }

  const transferTo = normalizeSipTransferDestination(destination);
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const participants = await rooms.listParticipants(roomName);
  const caller = participants.find(
    (participant) => participant.kind === ParticipantInfo_Kind.SIP
      || participant.identity.startsWith("phone-")
      || participant.identity.startsWith("sip_"),
  );
  if (!caller) throw new HttpError(409, "No SIP caller is connected to transfer.");

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const fromNumber = transferCallerId(roomName, caller.attributes ?? {});
  if (!fromNumber) {
    throw new HttpError(409, "The inbound clinic number could not be resolved for the transfer call.");
  }
  const outboundCallerId = await transferOutboundCallerId(sip, fromNumber);
  const handoffIdentity = `handoff-${transferTo.replace(/\D/g, "")}-${Date.now()}`;

  // Dial the human into the caller's existing room instead of issuing SIP
  // REFER. REFER can disconnect the original leg before the carrier has
  // established the destination call. waitUntilAnswered keeps the caller and
  // AI connected if the destination rejects, times out, or does not answer.
  const handoff = await sip.createSipParticipant(
    env.livekitSipOutboundTrunkId,
    transferTo,
    roomName,
    {
      fromNumber: outboundCallerId,
      participantIdentity: handoffIdentity,
      participantName: "Human handoff",
      participantMetadata: JSON.stringify({ role: "human-handoff", transferredCaller: caller.identity }),
      waitUntilAnswered: true,
      playDialtone: true,
      ringingTimeout: 30,
      maxCallDuration: 3600,
    },
  );

  console.log(JSON.stringify({
    event: "human-handoff-answered",
    room: roomName,
    callerIdentity: caller.identity,
    handoffIdentity,
  }));

  // Once the human has answered, remove agent participants so the room
  // becomes a private caller-to-human bridge. Removing the agent never removes
  // either SIP leg or deletes the room.
  const connected = await rooms.listParticipants(roomName);
  const agents = connected.filter((participant) => participant.kind === ParticipantInfo_Kind.AGENT);
  await Promise.all(agents.map(async (participant) => {
    await rooms.removeParticipant(roomName, participant.identity);
  }));

  return { transferred: true, participantId: handoff.participantId };
}

async function transferOutboundCallerId(sip: SipClient, inboundNumber: string) {
  const [trunk] = await sip.listSipOutboundTrunk({
    trunkIds: [env.livekitSipOutboundTrunkId],
  });
  if (!trunk) {
    throw new HttpError(503, "Configured outbound SIP trunk was not found in LiveKit.");
  }

  // A DID that receives inbound calls is not necessarily authorized by the
  // provider as an outbound caller ID. Prefer it only when the trunk permits
  // it; otherwise use the trunk's first configured E.164 caller ID.
  if (trunk.numbers.includes("*")) return inboundNumber;
  const configured = trunk.numbers.find((number) => /^\+[1-9]\d{7,14}$/.test(number));
  if (configured) return configured;

  throw new HttpError(
    503,
    "The outbound SIP trunk has no caller ID authorized for human handoff.",
  );
}

function transferCallerId(roomName: string, attributes: Record<string, string>) {
  const candidates = [
    attributes["sip.trunkPhoneNumber"],
    attributes["sip.to"],
    attributes["sip.h.to"],
  ];
  const roomNumber = /^inbound-(\d{7,15})-/.exec(roomName)?.[1];
  if (roomNumber) candidates.push(roomNumber);

  for (const candidate of candidates) {
    const match = String(candidate ?? "").match(/\+?[1-9]\d{6,14}/);
    if (!match) continue;
    return match[0].startsWith("+") ? match[0] : `+${match[0]}`;
  }
  return "";
}

function normalizeSipTransferDestination(destination: string) {
  const raw = destination.trim();
  if (!raw) {
    throw new HttpError(400, "Configure a transfer phone number before using human handoff.");
  }
  const withoutScheme = raw.replace(/^(?:sip|sips|tel):/i, "");
  const phone = withoutScheme.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  if (/^[1-9]\d{7,14}$/.test(phone)) return `+${phone}`;
  throw new HttpError(400, "Transfer phone must include a country code, for example +919876543210.");
}

type StaleInboundRoute = {
  dispatchRuleId: string;
  ownerId: string;
  routeMutationId: string;
  fingerprint: string;
};

export type InboundRouteChange = {
  route: SIPDispatchRuleInfo;
  number: string;
  ownerId: string;
  mutationId: string;
  previousRoute: SIPDispatchRuleInfo | null;
  staleRoutes: StaleInboundRoute[];
};

async function rollbackInboundRouteWithClient(
  sip: SipClient,
  change: InboundRouteChange,
) {
  const currentRoutes = (await sip.listSipDispatchRule()).filter(
    (item) => routeOwnerId(item) === change.ownerId
      && routeMutationId(item) === change.mutationId,
  );
  for (const current of currentRoutes) {
    if (
      change.previousRoute
      && current.sipDispatchRuleId === change.previousRoute.sipDispatchRuleId
    ) {
      await sip.updateSipDispatchRule(
        current.sipDispatchRuleId,
        change.previousRoute,
      );
      continue;
    }
    await sip.deleteSipDispatchRule(current.sipDispatchRuleId);
  }
}

export async function rollbackInboundRoute(change: InboundRouteChange) {
  requireLiveKit();
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  await rollbackInboundRouteWithClient(sip, change);
}

export async function finalizeInboundRoute(change: InboundRouteChange) {
  requireLiveKit();
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const [routes, inboundTrunks] = await Promise.all([
    sip.listSipDispatchRule(),
    sip.listSipInboundTrunk(),
  ]);
  const replacement = routes.find(
    (item) => item.sipDispatchRuleId === change.route.sipDispatchRuleId,
  );
  if (
    !replacement
    || routeOwnerId(replacement) !== change.ownerId
    || routeMutationId(replacement) !== change.mutationId
  ) {
    throw new HttpError(
      409,
      "The inbound route changed before its LiveKit cleanup completed. Sync phone routes before retrying.",
    );
  }

  const routeById = new Map(routes.map((item) => [item.sipDispatchRuleId, item]));
  for (const stale of change.staleRoutes) {
    const current = routeById.get(stale.dispatchRuleId);
    if (!current || current.sipDispatchRuleId === replacement.sipDispatchRuleId) continue;
    if (routeOwnerId(current) !== stale.ownerId) continue;
    if (routeMutationId(current) !== stale.routeMutationId) continue;
    if (current.toJsonString() !== stale.fingerprint) continue;
    if (!routeMatchesNumber(current, change.number)) continue;
    await sip.deleteSipDispatchRule(current.sipDispatchRuleId);
  }

  const matchingRouteIds = new Set(
    routes
      .filter((item) => routeMatchesNumber(item, change.number))
      .map((item) => item.sipDispatchRuleId),
  );
  const trunkById = new Map(inboundTrunks.map((item) => [item.sipTrunkId, item]));
  await deleteLegacyWildcardRules(
    sip,
    routes.filter((item) => !matchingRouteIds.has(item.sipDispatchRuleId)),
    trunkById,
  );
  const keepTrunkId = replacement.trunkIds[0];
  if (keepTrunkId) {
    await cleanUpNumberInboundTrunks(
      sip,
      inboundTrunks,
      keepTrunkId,
      change.number,
    );
  }
}

export async function createInboundRoute(
  agent: VoiceAgentDocument,
  number: string,
  mutationId: string,
  preferredDispatchRuleId = "",
): Promise<InboundRouteChange> {
  requireLiveKit();
  if (!mutationId.trim()) {
    throw new HttpError(500, "Inbound route creation requires a mutation fence.");
  }

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const routes = await sip.listSipDispatchRule();
  const matchingRoutes = routes.filter((item) => routeMatchesNumber(item, number));
  const agentOwnerId = String(agent.ownerId);
  const foreignOwnerIds = [
    ...new Set(
      matchingRoutes
        .map(routeOwnerId)
        .filter((ownerId) => ownerId && ownerId !== agentOwnerId),
    ),
  ];
  for (const foreignOwnerId of foreignOwnerIds) {
    const activeOwner = await PhoneNumberModel.exists({ ownerId: foreignOwnerId, number });
    if (activeOwner) {
      throw new HttpError(
        409,
        "This phone number already has an inbound route for another workspace. Remove it there before assigning it here.",
      );
    }
  }

  // Validate route ownership before mutating or creating a LiveKit trunk.
  const trunk = await ensureNumberInboundTrunk(sip, number);
  const route = inboundRouteInfo(agent, number, trunk.sipTrunkId, mutationId);
  const existingRoute = matchingRoutes.find(
    (item) => item.sipDispatchRuleId === preferredDispatchRuleId,
  ) ?? matchingRoutes[0];
  const previousRoute = existingRoute?.clone() ?? null;
  if (existingRoute) route.sipDispatchRuleId = existingRoute.sipDispatchRuleId;
  const routeChange: InboundRouteChange = {
    route,
    number,
    ownerId: agentOwnerId,
    mutationId,
    previousRoute,
    staleRoutes: matchingRoutes
      .filter((item) => item.sipDispatchRuleId !== existingRoute?.sipDispatchRuleId)
      .map((item) => ({
        dispatchRuleId: item.sipDispatchRuleId,
        ownerId: routeOwnerId(item),
        routeMutationId: routeMutationId(item),
        fingerprint: item.toJsonString(),
      })),
  };

  try {
    // LiveKit allows only one unpinned matching rule per trunk. Snapshot the
    // committed rule before replacing it so a failed MongoDB write can restore
    // that exact rule id and configuration.
    let savedRoute = existingRoute
      ? await sip.updateSipDispatchRule(existingRoute.sipDispatchRuleId, route)
      : await createInboundDispatchRule(sip, route);
    savedRoute = await ensureInboundAgentDispatch(sip, savedRoute);
    routeChange.route = savedRoute;
    return routeChange;
  } catch (error) {
    await rollbackInboundRouteWithClient(sip, routeChange).catch((cleanupError) => {
      console.error(JSON.stringify({
        event: "inbound-route-create-compensation-failed",
        dispatchRuleId: routeChange.route.sipDispatchRuleId,
        ownerId: agentOwnerId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }));
    });
    throw error;
  }
}

export async function refreshInboundRoutesForAgent(agent: VoiceAgentDocument) {
  const phoneNumbers = await PhoneNumberModel.find({
    ownerId: agent.ownerId,
    agentId: agent._id,
    direction: { $in: ["Inbound", "Both"] },
    lifecycle: { $ne: "deleting" },
  }).select("_id number");
  const errors: string[] = [];
  let refreshed = 0;

  for (const phoneNumber of phoneNumbers) {
    let phoneMutation;
    try {
      phoneMutation = await acquirePhoneNumberMutation(
        String(agent.ownerId),
        String(phoneNumber._id),
      );
      const lockedPhone = phoneMutation.phone;
      if (
        String(lockedPhone.agentId ?? "") !== String(agent._id)
        || !["Inbound", "Both"].includes(lockedPhone.direction)
      ) {
        continue;
      }

      // Quiesce the committed route before touching LiveKit. If any later
      // provider or database step fails, inbound admission remains fail-closed.
      await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
      await phoneMutation.assertHeld();
      const routeChange = await createInboundRoute(
        agent,
        lockedPhone.number,
        phoneMutation.token,
        lockedPhone.dispatchRuleId,
      );
      const route = routeChange.route;
      if (!route.sipDispatchRuleId) {
        await rollbackInboundRoute(routeChange).catch(() => undefined);
        throw new Error("LiveKit did not return an inbound dispatch rule id.");
      }
      try {
        await phoneMutation.updateLocked({
          $set: {
            dispatchRuleId: route.sipDispatchRuleId,
            inboundTrunkId: route.trunkIds[0] ?? lockedPhone.inboundTrunkId,
            status: "Ready",
          },
        });
        refreshed += 1;
      } catch (error) {
        await rollbackInboundRoute(routeChange).catch(() => undefined);
        throw error;
      }
      await phoneMutation.assertHeld()
        .then(() => finalizeInboundRoute(routeChange))
        .catch((error) => {
          errors.push(
            `${phoneNumber.number}: route saved, but stale-route cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    } catch (error) {
      errors.push(
        `${phoneNumber.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await phoneMutation?.release().catch(() => undefined);
    }
  }

  return { refreshed, errors };
}

export async function deleteInboundRoute(dispatchRuleId: string, ownerId = "") {
  requireLiveKit();
  if (!dispatchRuleId) return;
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  if (ownerId) {
    const route = (await sip.listSipDispatchRule()).find((item) => item.sipDispatchRuleId === dispatchRuleId);
    const routeOwner = route ? routeOwnerId(route) : "";
    if (routeOwner && routeOwner !== ownerId) return;
  }
  await sip.deleteSipDispatchRule(dispatchRuleId);
}

function businessHoursRuntime(agent: VoiceAgentDocument) {
  const timezone = safeTimezone(agent.businessHours?.timezone);
  if (!agent.businessHoursEnabled || !agent.businessHours?.schedule?.length) {
    return { enabled: false, open: true, timezone };
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
    const day = String(parts.weekday ?? "").toLowerCase().slice(0, 3);
    const time = `${parts.hour}:${parts.minute}`;
    const schedule = agent.businessHours.schedule.find((item) => item.day === day);
    return {
      enabled: true,
      open: Boolean(schedule?.enabled && time >= schedule.start && time <= schedule.end),
      timezone,
    };
  } catch {
    return { enabled: true, open: false, timezone };
  }
}

export async function getAgentRuntimeSnapshot(agent: VoiceAgentDocument): Promise<AgentRuntimeSnapshot> {
  const [activeCalls, currentCall, phoneNumber, phoneStatsResult] = await Promise.all([
    CallDetailRecordModel.countDocuments({
      ownerId: agent.ownerId,
      agentId: agent._id,
      status: { $in: openCallStatuses },
    }),
    CallDetailRecordModel.findOne({
      ownerId: agent.ownerId,
      agentId: agent._id,
      status: { $in: openCallStatuses },
    })
      .select("livekitRoomName livekitDispatchId")
      .sort({ updatedAt: -1 }),
    PhoneNumberModel.findOne({
      ownerId: agent.ownerId,
      agentId: agent._id,
      lifecycle: { $ne: "deleting" },
    })
      .select("number provider direction status inboundTrunkId dispatchRuleId outboundTrunkId")
      .sort({ updatedAt: -1 }),
    CallDetailRecordModel.aggregate<{
      totalCalls: number;
      activeCalls: number;
      completedCalls: number;
      finishedCalls: number;
    }>([
      {
        $match: {
          ownerId: agent.ownerId,
          agentId: agent._id,
          direction: { $in: ["inbound", "outbound"] },
        },
      },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          activeCalls: {
            $sum: { $cond: [{ $in: ["$status", openCallStatuses] }, 1, 0] },
          },
          completedCalls: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          finishedCalls: {
            $sum: { $cond: [{ $in: ["$status", ["completed", "failed", "cancelled"]] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  let health: AgentDispatchHealth | null = null;
  if (currentCall && env.livekitUrl && env.livekitApiKey && env.livekitApiSecret) {
    try {
      health = await getAgentDispatchHealth(currentCall.livekitRoomName, currentCall.livekitDispatchId);
    } catch {
      health = null;
    }
  }

  const workerId = health?.jobs.find((job) => job.status === "running")?.workerId
    ?? health?.jobs.find((job) => job.workerId)?.workerId
    ?? "";
  const realtime = agent.pipelineMode === "realtime";
  const realtimeModel = normalizeRealtimeModelForAgent(agent);
  const metrics = agent.latencyMetrics;
  const phoneStats = phoneStatsResult[0];
  const routeDirection = phoneNumber?.direction ?? "";
  const routeReady = phoneNumber?.status === "Ready";

  return {
    agentId: agent.id,
    agentStatus: agent.status,
    observedAt: new Date().toISOString(),
    dispatch: {
      state: health?.state ?? (currentCall ? "unknown" : "idle"),
      message: health?.message ?? (currentCall ? "LiveKit status is temporarily unavailable." : "No active call room."),
      roomName: currentCall?.livekitRoomName ?? "",
      dispatchId: health?.dispatchId ?? currentCall?.livekitDispatchId ?? "",
      workerId,
    },
    region: health?.region ?? "",
    activeCalls,
    maxConcurrentCalls: agent.maxConcurrentCalls,
    pipeline: {
      mode: agent.pipelineMode,
      label: realtime
        ? `${agent.realtimeProvider}/${realtimeModel}`
        : `${agent.sttProvider} â†’ ${agent.llmProvider} â†’ ${agent.ttsProvider}`,
      stt: realtime ? "Native realtime" : `${agent.sttProvider}/${agent.sttModel}`,
    },
    latency: {
      latestMs: metrics?.latestMs ?? null,
      averageMs: metrics?.averageMs ?? null,
      sampleCount: metrics?.sampleCount ?? 0,
      measuredAt: metrics?.lastMeasuredAt?.toISOString() ?? "",
    },
    businessHours: businessHoursRuntime(agent),
    phoneRoute: {
      number: phoneNumber?.number || agent.phone || "",
      provider: phoneNumber?.provider ?? "",
      direction: routeDirection,
      status: phoneNumber?.status ?? "Unassigned",
      inboundReady: Boolean(
        phoneNumber
          && routeReady
          && routeDirection !== "Outbound"
          && phoneNumber.inboundTrunkId
          && phoneNumber.dispatchRuleId
      ),
      outboundReady: Boolean(
        phoneNumber
          && routeReady
          && routeDirection !== "Inbound"
          && phoneNumber.outboundTrunkId
      ),
      totalCalls: phoneStats?.totalCalls ?? 0,
      activeCalls: phoneStats?.activeCalls ?? 0,
      completionRate: phoneStats?.finishedCalls
        ? Math.round((phoneStats.completedCalls / phoneStats.finishedCalls) * 1000) / 10
        : null,
    },
  };
}

export async function removeInboundRoute(number: string, ownerId = "") {
  requireLiveKit();

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const routes = await sip.listSipDispatchRule();
  const matchingRoutes = routes.filter((item) => {
    if (!routeMatchesNumber(item, number)) return false;
    const routeOwner = routeOwnerId(item);
    return !ownerId || !routeOwner || routeOwner === ownerId;
  });
  for (const route of matchingRoutes) {
    await sip.deleteSipDispatchRule(route.sipDispatchRuleId);
  }
}

export async function removePhoneNumberRouting(number: string, ownerId = "") {
  requireLiveKit();

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const [routes, inboundTrunks] = await Promise.all([
    sip.listSipDispatchRule(),
    sip.listSipInboundTrunk(),
  ]);

  const matchingRoutes = routes.filter((item) => {
    if (!routeMatchesNumber(item, number)) return false;
    const routeOwner = routeOwnerId(item);
    return !ownerId || !routeOwner || routeOwner === ownerId;
  });
  for (const route of matchingRoutes) {
    await sip.deleteSipDispatchRule(route.sipDispatchRuleId);
  }

  const variants = new Set(inboundNumberVariants(number));
  for (const trunk of inboundTrunks) {
    if (trunk.numbers.includes("*")) continue;
    const toRemove = trunk.numbers.filter((trunkNumber) => variants.has(trunkNumber));
    if (toRemove.length === 0) continue;

    const remaining = trunk.numbers.filter((trunkNumber) => !variants.has(trunkNumber));
    const dedicatedToNumber = isManagedNumberTrunk(trunk) || isTrunkDedicatedToNumber(trunk, variants);
    if (remaining.length === 0) {
      if (dedicatedToNumber) {
        await sip.deleteSipTrunk(trunk.sipTrunkId);
      }
      continue;
    }

    await sip.updateSipInboundTrunkFields(trunk.sipTrunkId, {
      numbers: new ListUpdate({ remove: toRemove }),
    });
  }
}

export async function listLiveKitTrunks() {
  requireLiveKit();
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const [inbound, outbound] = await Promise.all([
    sip.listSipInboundTrunk(),
    sip.listSipOutboundTrunk(),
  ]);

  return {
    inbound: inbound.map((trunk) => ({
      id: trunk.sipTrunkId,
      name: trunk.name,
      numbers: trunk.numbers,
    })),
    outbound: outbound.map((trunk) => ({
      id: trunk.sipTrunkId,
      name: trunk.name,
      numbers: trunk.numbers,
    })),
  };
}


