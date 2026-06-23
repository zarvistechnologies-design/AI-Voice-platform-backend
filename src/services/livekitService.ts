import {
  CreateSIPDispatchRuleRequest,
  AgentDispatch,
  JobStatus,
  ListUpdate,
  RoomAgentDispatch,
  RoomConfiguration,
  SIPDispatchRule,
  SIPDispatchRuleIndividual,
  SIPDispatchRuleInfo,
} from "@livekit/protocol";
import { AccessToken, AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";

import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import type { VoiceAgentDocument } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { modelCatalog, voiceLanguages } from "./modelCatalog.js";
import { createCallRecord, failCall } from "./callRecordService.js";

const openCallStatuses = ["initiated", "ringing", "active"];
const staleEmptyRoomMs = 90_000;

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
] as const;

function requireLiveKit() {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new HttpError(503, "LiveKit voice routing is not configured.");
  }
}

function apiUrl() {
  return env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
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

function metadataForAgent(
  agent: VoiceAgentDocument,
  callId = "",
  options: { callDirection?: "web" | "inbound" | "outbound"; callerParticipantIdentity?: string } = {},
) {
  const knowledgeContext = agent.knowledgeDocuments
    .filter((document) => document.status === "ready")
    .map((document) => `## ${document.name}\n${document.content}`)
    .join("\n\n")
    .slice(0, 30000);
  return JSON.stringify({
    callId,
    callDirection: options.callDirection ?? "",
    callerParticipantIdentity: options.callerParticipantIdentity ?? "",
    ownerId: agent.ownerId,
    agentId: agent.id,
    name: agent.name,
    providerModel: agent.providerModel,
    pipelineMode: agent.pipelineMode,
    realtimeProvider: agent.realtimeProvider,
    realtimeModel: agent.realtimeModel,
    llmProvider: agent.llmProvider,
    llmModel: agent.llmModel,
    sttProvider: agent.sttProvider,
    sttModel: agent.sttModel,
    ttsProvider: agent.ttsProvider,
    ttsModel: agent.ttsModel,
    temperature: agent.temperature,
    voiceSpeed: agent.voiceSpeed,
    voicePitch: agent.voicePitch,
    interruptionSensitivity: agent.interruptionSensitivity,
    backgroundNoise: agent.backgroundNoise,
    prompt: knowledgeContext
      ? `${agent.prompt}\n\nUse the following organization-approved knowledge when relevant:\n${knowledgeContext}`
      : agent.prompt,
    firstMessage: agent.firstMessage,
    firstMessageMode: agent.firstMessageMode,
    language: agent.language,
    voice: agent.voice,
    behavior: agent.behavior,
    callSettings: agent.callSettings,
    tools: agent.tools.filter((tool) => tool.enabled),
    analysisPlan: agent.analysisPlan,
    dynamicVariables: agent.dynamicVariables,
    prefetchWebhook: agent.prefetchWebhook,
    endOfCallWebhook: agent.endOfCallWebhook,
  });
}

function dispatchForAgent(
  agent: VoiceAgentDocument,
  callId = "",
  options: { callDirection?: "web" | "inbound" | "outbound"; callerParticipantIdentity?: string } = {},
) {
  return new RoomAgentDispatch({
    agentName: env.livekitAgentName,
    metadata: metadataForAgent(agent, callId, options),
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

function inboundRouteInfo(agent: VoiceAgentDocument, number: string) {
  return new SIPDispatchRuleInfo({
    rule: new SIPDispatchRule({
      rule: {
        case: "dispatchRuleIndividual",
        value: new SIPDispatchRuleIndividual({ roomPrefix: inboundRoomPrefix(number) }),
      },
    }),
    name: `${agent.name} - ${number}`,
    trunkIds: [env.livekitSipInboundTrunkId],
    metadata: metadataForAgent(agent, "", { callDirection: "inbound" }),
    roomConfig: new RoomConfiguration({
      agents: [dispatchForAgent(agent, "", { callDirection: "inbound" })],
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

async function deleteLegacyWildcardRules(sip: SipClient, routes: SIPDispatchRuleInfo[]) {
  for (const route of routes) {
    if (route.inboundNumbers.length > 0 || route.numbers.length > 0) continue;
    await sip.deleteSipDispatchRule(route.sipDispatchRuleId);
  }
}

type SipClientInternals = {
  rpc: {
    request(
      service: string,
      method: string,
      data: ReturnType<CreateSIPDispatchRuleRequest["toJson"]>,
      headers: Record<string, string>,
    ): Promise<Parameters<typeof SIPDispatchRuleInfo.fromJson>[0]>;
  };
  authHeader(
    grant: Record<string, never>,
    sip: { admin: true },
  ): Promise<Record<string, string>>;
};

async function createNumberScopedDispatchRule(sip: SipClient, route: SIPDispatchRuleInfo) {
  const client = sip as unknown as SipClientInternals;
  const data = await client.rpc.request(
    "SIP",
    "CreateSIPDispatchRule",
    new CreateSIPDispatchRuleRequest({
      rule: route.rule,
      trunkIds: route.trunkIds,
      hidePhoneNumber: route.hidePhoneNumber,
      name: route.name,
      metadata: route.metadata,
      attributes: route.attributes,
      roomPreset: route.roomPreset,
      roomConfig: route.roomConfig,
    }).toJson(),
    await client.authHeader({}, { admin: true }),
  );
  return SIPDispatchRuleInfo.fromJson(data, { ignoreUnknownFields: true });
}

async function ensureOutboundCallerId(sip: SipClient, fromNumber: string) {
  const [trunk] = await sip.listSipOutboundTrunk({
    trunkIds: [env.livekitSipOutboundTrunkId],
  });
  if (!trunk) {
    throw new HttpError(503, "Configured outbound SIP trunk was not found in LiveKit.");
  }
  if (trunk.numbers.length === 0 || trunk.numbers.includes("*") || trunk.numbers.includes(fromNumber)) {
    return;
  }

  await sip.updateSipOutboundTrunkFields(env.livekitSipOutboundTrunkId, {
    numbers: new ListUpdate({ add: [fromNumber] }),
  });
}

async function ensureInboundTrunkNumbers(sip: SipClient, phoneNumber: string) {
  const [trunk] = await sip.listSipInboundTrunk({
    trunkIds: [env.livekitSipInboundTrunkId],
  });
  if (!trunk) {
    throw new HttpError(503, "Configured inbound SIP trunk was not found in LiveKit.");
  }

  const variants = inboundNumberVariants(phoneNumber);
  const missing = variants.filter((number) => !trunk.numbers.includes(number));
  if (missing.length === 0) return;

  await sip.updateSipInboundTrunkFields(env.livekitSipInboundTrunkId, {
    numbers: new ListUpdate({ add: missing }),
  });
}

export function livekitConfiguration() {
  return {
    configured: Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret),
    url: env.livekitUrl,
    agentName: env.livekitAgentName,
    sip: {
      inboundConfigured: Boolean(env.livekitSipInboundTrunkId),
      outboundConfigured: Boolean(env.livekitSipOutboundTrunkId),
      inboundDestinationConfigured: Boolean(inferredLiveKitSipUri()),
      callerId: "",
    },
    providers: providerCatalog,
    languageCatalog: voiceLanguages,
    modelCatalog,
    pricing: {
      currency: "USD",
      llmPerMillionTokens: env.costRates.llmPerMillionTokens,
      sttPerMinute: env.costRates.sttPerMinute,
      ttsPerMillionCharacters: env.costRates.ttsPerMillionCharacters,
      telephonyPerMinute: env.costRates.telephonyPerMinute,
      markupMultiplier: env.billing.markupMultiplier,
    },
    latencyGuide: {
      realtime: { openai: 650, gemini: 750 },
      llm: { openai: 600, gemini: 700, sarvam: 850 },
      stt: { openai: 320, sarvam: 450 },
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
    .select("_id livekitRoomName status startedAt createdAt updatedAt")
    .lean();
  if (openCalls.length === 0) return;

  try {
    const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
    const liveRooms = await rooms.listRooms(openCalls.map((call) => call.livekitRoomName));
    const liveRoomByName = new Map(liveRooms.map((room) => [room.name, room]));
    const endedAt = new Date();
    let closed = 0;

    for (const call of openCalls) {
      const liveRoom = liveRoomByName.get(call.livekitRoomName);
      const emptyTooLong =
        liveRoom &&
        Number(liveRoom.numParticipants ?? 0) === 0 &&
        olderThan(call.updatedAt ?? call.createdAt, staleEmptyRoomMs);

      if (liveRoom && !emptyTooLong) continue;

      if (liveRoom) {
        await rooms.deleteRoom(call.livekitRoomName).catch(() => undefined);
      }

      const result = await CallDetailRecordModel.updateOne(
        { _id: call._id, status: { $in: openCallStatuses } },
        {
          $set: {
            status: "failed",
            endedAt,
            durationSeconds: callDurationSeconds(call.startedAt, endedAt),
            endReason: liveRoom ? "stale_empty_livekit_room" : "stale_missing_livekit_room",
            errorMessage: liveRoom
              ? "LiveKit room stayed empty while call record was still open."
              : "LiveKit room no longer exists while call record was still open.",
          },
        },
      );
      closed += result.modifiedCount;
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

export async function createWebCallToken(agent: VoiceAgentDocument, ownerId: string) {
  requireLiveKit();
  const name = roomName("web-call", ownerId);
  const call = await createCallRecord({
    ownerId,
    agentId: agent._id,
    livekitRoomName: name,
    direction: "web",
    llmProvider: agent.llmProvider,
    sttProvider: agent.sttProvider,
    ttsProvider: agent.ttsProvider,
  });
  const metadata = metadataForAgent(agent, call.id, { callDirection: "web" });
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
      identity: `web-${crypto.randomUUID()}`,
      name: "Dashboard test caller",
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

export async function startOutboundCall(
  agent: VoiceAgentDocument,
  ownerId: string,
  destination: string,
  fromNumber: string,
) {
  requireLiveKit();
  if (!env.livekitSipOutboundTrunkId) {
    throw new HttpError(503, "Outbound phone routing is not configured.");
  }

  const name = roomName("outbound-call", ownerId);
  const call = await createCallRecord({
    ownerId,
    agentId: agent._id,
    livekitRoomName: name,
    direction: "outbound",
    callerNumber: fromNumber,
    calledNumber: destination,
    llmProvider: agent.llmProvider,
    sttProvider: agent.sttProvider,
    ttsProvider: agent.ttsProvider,
  });
  const participantIdentity = `phone-${destination.replace(/\D/g, "")}-${Date.now()}`;
  const metadata = metadataForAgent(agent, call.id, {
    callDirection: "outbound",
    callerParticipantIdentity: participantIdentity,
  });
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const dispatch = new AgentDispatchClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const startedAt = Date.now();
  try {
    await ensureOutboundCallerId(sip, fromNumber);

    await rooms.createRoom({
      name,
      emptyTimeout: 60,
      departureTimeout: 30,
      metadata,
    });
    console.log(JSON.stringify({ event: "outbound-room-created", callId: call.id, room: name, elapsedMs: Date.now() - startedAt }));

    const agentDispatch = await dispatch.createDispatch(name, env.livekitAgentName, { metadata });
    await CallDetailRecordModel.updateOne(
      { livekitRoomName: name },
      { $set: { livekitDispatchId: agentDispatch.id } },
    );
    console.log(JSON.stringify({ event: "outbound-agent-dispatched", callId: call.id, room: name, elapsedMs: Date.now() - startedAt }));

    const participant = await sip.createSipParticipant(
      env.livekitSipOutboundTrunkId,
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
    await failCall(name, error);
    throw error;
  }
}

export async function transferSipCall(roomName: string, destination: string) {
  requireLiveKit();
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const participants = await rooms.listParticipants(roomName);
  const phone = participants.find((participant) => participant.kind === 3 || participant.identity.startsWith("phone-"));
  if (!phone) throw new HttpError(409, "No SIP caller is connected to transfer.");
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  await sip.transferSipParticipant(roomName, phone.identity, destination, { playDialtone: true, ringingTimeout: 30 });
  return { transferred: true, destination };
}

export async function createInboundRoute(agent: VoiceAgentDocument, number: string) {
  requireLiveKit();
  if (!env.livekitSipInboundTrunkId) {
    throw new HttpError(503, "Inbound phone routing is not configured.");
  }

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  await ensureInboundTrunkNumbers(sip, number);
  const route = inboundRouteInfo(agent, number);
  const routes = await sip.listSipDispatchRule({
    trunkIds: [env.livekitSipInboundTrunkId],
  });
  const existing = routes.find((item) => routeMatchesNumber(item, number));

  if (existing) {
    if (existing.inboundNumbers.length === 0 && existing.numbers.length === 0) {
      await sip.deleteSipDispatchRule(existing.sipDispatchRuleId);
      return createNumberScopedDispatchRule(sip, route);
    }
    route.sipDispatchRuleId = existing.sipDispatchRuleId;
    return sip.updateSipDispatchRule(existing.sipDispatchRuleId, route);
  }

  await deleteLegacyWildcardRules(sip, routes);
  return createNumberScopedDispatchRule(sip, route);
}

function businessHoursRuntime(agent: VoiceAgentDocument) {
  const timezone = agent.businessHours?.timezone || "UTC";
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
    }).sort({ updatedAt: -1 }),
    PhoneNumberModel.findOne({
      ownerId: agent.ownerId,
      agentId: agent._id,
    }).sort({ updatedAt: -1 }),
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
        ? `${agent.realtimeProvider}/${agent.realtimeModel}`
        : `${agent.sttProvider} → ${agent.llmProvider} → ${agent.ttsProvider}`,
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

export async function removeInboundRoute(number: string) {
  requireLiveKit();
  if (!env.livekitSipInboundTrunkId) return;

  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const routes = await sip.listSipDispatchRule({
    trunkIds: [env.livekitSipInboundTrunkId],
  });
  const existing = routes.find((item) => routeMatchesNumber(item, number));
  if (existing) {
    await sip.deleteSipDispatchRule(existing.sipDispatchRuleId);
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
