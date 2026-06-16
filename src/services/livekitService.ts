import {
  CreateSIPDispatchRuleRequest,
  ListUpdate,
  RoomAgentDispatch,
  RoomConfiguration,
  SIPDispatchRule,
  SIPDispatchRuleIndividual,
  SIPDispatchRuleInfo,
} from "@livekit/protocol";
import { AccessToken, AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";

import { env } from "../config/env.js";
import type { VoiceAgentDocument } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { modelCatalog, voiceLanguages } from "./modelCatalog.js";
import { createCallRecord, failCall } from "./callRecordService.js";

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
    throw new HttpError(503, "Platform voice routing is not configured.");
  }
}

function apiUrl() {
  return env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function metadataForAgent(agent: VoiceAgentDocument, callId = "") {
  const knowledgeContext = agent.knowledgeDocuments
    .filter((document) => document.status === "ready")
    .map((document) => `## ${document.name}\n${document.content}`)
    .join("\n\n")
    .slice(0, 30000);
  return JSON.stringify({
    callId,
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
    language: agent.language,
    voice: agent.voice,
    behavior: agent.behavior,
    callSettings: agent.callSettings,
    tools: agent.tools.filter((tool) => tool.enabled),
    dynamicVariables: agent.dynamicVariables,
    prefetchWebhook: agent.prefetchWebhook,
    endOfCallWebhook: agent.endOfCallWebhook,
  });
}

function dispatchForAgent(agent: VoiceAgentDocument, callId = "") {
  return new RoomAgentDispatch({
    agentName: env.livekitAgentName,
    metadata: metadataForAgent(agent, callId),
  });
}

function roomName(prefix: string, ownerId: string) {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12);
  return `${prefix}-${safeOwner}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function inboundRoomPrefix(number: string) {
  return `inbound-${number.replace(/\D/g, "")}-`;
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
    numbers: [number],
    metadata: metadataForAgent(agent),
    roomConfig: new RoomConfiguration({
      agents: [dispatchForAgent(agent)],
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
  const scopedToNumber = route.numbers.includes(number);
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
  };
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
  const metadata = metadataForAgent(agent, call.id);
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  await rooms.createRoom({
    name,
    emptyTimeout: 60,
    departureTimeout: 30,
    metadata,
    agents: [dispatchForAgent(agent, call.id)],
  });
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
    agents: [dispatchForAgent(agent, call.id)],
    emptyTimeout: 60,
    departureTimeout: 30,
  });

  return {
    callId: call.id,
    roomName: name,
    serverUrl: env.livekitUrl,
    participantToken: await token.toJwt(),
  };
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
  const metadata = metadataForAgent(agent, call.id);
  const rooms = new RoomServiceClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const sip = new SipClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const dispatch = new AgentDispatchClient(apiUrl(), env.livekitApiKey, env.livekitApiSecret);
  try {
    await ensureOutboundCallerId(sip, fromNumber);

    await rooms.createRoom({
      name,
      emptyTimeout: 60,
      departureTimeout: 30,
      metadata,
    });

    const participant = await sip.createSipParticipant(
      env.livekitSipOutboundTrunkId,
      destination,
      name,
      {
        fromNumber,
        participantIdentity: `phone-${destination.replace(/\D/g, "")}-${Date.now()}`,
        participantName: destination,
        participantMetadata: metadata,
        waitUntilAnswered: true,
        playDialtone: true,
        krispEnabled: true,
        ringingTimeout: 30,
        maxCallDuration: agent.behavior?.maxCallDurationSeconds ?? 1200,
      },
    );

    await dispatch.createDispatch(name, env.livekitAgentName, { metadata });

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
  const route = inboundRouteInfo(agent, number);
  const existing = (await sip.listSipDispatchRule({
    trunkIds: [env.livekitSipInboundTrunkId],
  })).find((item) => routeMatchesNumber(item, number));

  if (existing) {
    route.sipDispatchRuleId = existing.sipDispatchRuleId;
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
