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
    numbers: inboundNumberVariants(number),
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
  const variants = inboundNumberVariants(number);
  const scopedToNumber = variants.some((variant) => route.numbers.includes(variant));
  const oldWildcardForNumber = route.numbers.length === 0 && routeRoomPrefix(route) === roomPrefix;
  return scopedToNumber || oldWildcardForNumber;
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
    new CreateSIPDispatchRuleRequest({ dispatchRule: route }).toJson(),
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
  const dispatch = dispatchId
    ? await dispatchClient.getDispatch(dispatchId, roomName)
    : (await dispatchClient.listDispatch(roomName)).find((item) => item.agentName === env.livekitAgentName);
  return summarizeDispatch(dispatch, roomName, dispatchId);
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

    await dispatch.createDispatch(name, env.livekitAgentName, { metadata });
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

    return {
      callId: call.id,
      roomName: name,
      participantId: participant.participantId,
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
  const existing = (await sip.listSipDispatchRule({
    trunkIds: [env.livekitSipInboundTrunkId],
  })).find((item) => routeMatchesNumber(item, number));

  if (existing) {
    route.sipDispatchRuleId = existing.sipDispatchRuleId;
    if (existing.numbers.length === 0 && routeRoomPrefix(existing) === routeRoomPrefix(route)) {
      route.numbers = [];
    }
    return sip.updateSipDispatchRule(existing.sipDispatchRuleId, route);
  }

  return createNumberScopedDispatchRule(sip, route);
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
