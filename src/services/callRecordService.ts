import { randomUUID } from "node:crypto";
import { startSession, type ClientSession, type Types } from "mongoose";

import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { deductCreditsForCall } from "./billingService.js";
import {
  activateStagedWebhookEvents,
  enqueueWebhookEvent,
  stageWebhookEvent,
} from "./outboundWebhookService.js";
import {
  activateStagedIntegrationDeliveries,
  stagePostCallIntegrations,
} from "./integrationService.js";
import { finalizeCallIntelligence } from "./callIntelligenceService.js";
import {
  normalizeGeminiRealtimeModel,
  normalizeOpenAIRealtimeModel,
} from "./modelCatalog.js";
import { canonicalPricingProvider } from "./modelPricingService.js";

export type CallMetadata = {
  callId?: string;
  ownerId?: string;
  agentId?: string;
  callDirection?: string;
  fromPhone?: string;
  toPhone?: string;
  metadata?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  pipelineMode?: "pipeline" | "realtime";
  realtimeProvider?: string;
  realtimeModel?: string;
  language?: string;
  multilingualEnabled?: boolean;
  llmProvider?: string;
  llmModel?: string;
  sttProvider?: string;
  sttModel?: string;
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
};

function parseMetadata(metadata?: string): CallMetadata {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata) as CallMetadata;
  } catch {
    return {};
  }
}

function directionFromRoom(roomName: string): "web" | "inbound" | "outbound" {
  if (roomName.startsWith("inbound-")) return "inbound";
  if (roomName.startsWith("outbound-call-")) return "outbound";
  return "web";
}

export function effectiveModelSnapshot(input: CallMetadata) {
  const language = effectiveCallLanguage(input);
  if (input.pipelineMode === "realtime") {
    const realtimeProvider = canonicalPricingProvider(input.realtimeProvider);
    const realtimeModel = realtimeProvider === "gemini"
      ? normalizeGeminiRealtimeModel(input.realtimeModel ?? "")
      : realtimeProvider === "openai"
        ? normalizeOpenAIRealtimeModel(input.realtimeModel ?? "")
        : input.realtimeModel ?? "";
    return {
      pipelineMode: "realtime" as const,
      realtimeProvider,
      realtimeModel,
      language,
      llmProvider: realtimeProvider,
      llmModel: realtimeModel,
      sttProvider: "",
      sttModel: "",
      ttsProvider: "",
      ttsModel: "",
      ttsVoice: input.ttsVoice ?? "",
    };
  }
  return {
    pipelineMode: "pipeline" as const,
    realtimeProvider: canonicalPricingProvider(input.realtimeProvider),
    realtimeModel: input.realtimeModel ?? "",
    language,
    llmProvider: canonicalPricingProvider(input.llmProvider),
    llmModel: input.llmModel ?? "",
    sttProvider: canonicalPricingProvider(input.sttProvider),
    sttModel: input.sttModel ?? "",
    ttsProvider: canonicalPricingProvider(input.ttsProvider),
    ttsModel: input.ttsModel ?? "",
    ttsVoice: input.ttsVoice ?? "",
  };
}

export function effectiveCallLanguage(input: { language?: string; multilingualEnabled?: boolean }) {
  const language = input.language?.trim() ?? "";
  return input.multilingualEnabled || language.toLowerCase() === "multilingual"
    ? "Multilingual"
    : language;
}

function durationSeconds(startedAt: Date | null | undefined, endedAt: Date) {
  return startedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : 0;
}

function readableDate(value: unknown) {
  if (!value) return "unknown date";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "unknown date" : date.toISOString().slice(0, 10);
}

function compactValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/\s+/g, " ").trim().slice(0, 180);
  }
  return "";
}

function normalizePhoneDigits(digits: string, countryContext = "") {
  const contextDigits = countryContext.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (contextDigits.startsWith("91") && digits.length === 11 && digits.startsWith("0")) {
    return `+91${digits.slice(1)}`;
  }
  if (contextDigits.startsWith("91") && digits.length === 10) {
    return `+91${digits}`;
  }
  return digits;
}

function phoneValue(value: unknown, countryContext = "") {
  const text = compactValue(value);
  const e164 = text.match(/\+\d[\d\s().-]{5,}\d/);
  if (e164) return `+${e164[0].replace(/\D/g, "")}`;
  const local = text.match(/(?:^|\D)(\d{7,15})(?=\D|$)/)?.[1] ?? "";
  if (!local) return "";
  return normalizePhoneDigits(local, countryContext);
}

function firstPhone(...values: unknown[]) {
  for (const value of values) {
    const phone = phoneValue(value);
    if (phone) return phone;
  }
  return "";
}

function firstPhoneWithContext(countryContext: string, ...values: unknown[]) {
  for (const value of values) {
    const phone = phoneValue(value, countryContext);
    if (phone) return phone;
  }
  return "";
}

function formatRoomPhone(digits: string, destinationDigits = "") {
  if (!digits) return "";
  if (destinationDigits.startsWith("91") && digits.length === 11 && digits.startsWith("0")) {
    return `+91${digits.slice(1)}`;
  }
  if (destinationDigits.startsWith("91") && digits.length === 10) {
    return `+91${digits}`;
  }
  return digits.length >= 11 ? `+${digits}` : digits;
}

function inboundRoomNumbers(roomName: string) {
  const match = /^inbound-(\d{7,15})-(.*)$/.exec(roomName);
  if (!match) return { callerNumber: "", calledNumber: "" };
  const destinationDigits = match[1] ?? "";
  const suffix = match[2] ?? "";
  const callerDigits = [...suffix.matchAll(/\d{7,15}/g)]
    .map((item) => item[0])
    .find((digits) => digits !== destinationDigits) ?? "";
  return {
    callerNumber: formatRoomPhone(callerDigits, destinationDigits),
    calledNumber: formatRoomPhone(destinationDigits),
  };
}

function inboundNumberFromRoom(roomName: string) {
  return inboundRoomNumbers(roomName).calledNumber;
}

function inboundCallerNumberFromRoom(roomName: string) {
  return inboundRoomNumbers(roomName).callerNumber;
}

function phonesByKey(values: Record<string, unknown>, mode: "from" | "to") {
  const include =
    mode === "from"
      ? /(from|caller|customer|ani|clid|p-asserted|remote-party|phone)/i
      : /(to|called|callee|destination|dest|dialed|did|trunk|phone)/i;
  const exclude =
    mode === "from"
      ? /(to|called|callee|destination|dest|dialed|did|trunk|callid|call-id|uuid|sid|id$)/i
      : /(from|caller|customer|ani|clid|p-asserted|remote-party|callid|call-id|uuid|sid|id$)/i;
  return Object.entries(values)
    .filter(([key]) => include.test(key) && !exclude.test(key))
    .map(([, value]) => phoneValue(value))
    .filter(Boolean);
}

function sanitizedAttributeSnapshot(attributes: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => /(sip|from|caller|customer|ani|clid|p-asserted|remote-party|to|called|destination|trunk|phone)/i.test(key))
      .map(([key, value]) => [key, compactValue(value)]),
  );
}

function metadataRouteNumbers(roomName: string, metadata: CallMetadata) {
  const data = metadata.metadata ?? {};
  const variables = metadata.variables ?? {};
  const direction = metadata.callDirection || directionFromRoom(roomName);
  const roomNumbers = direction === "inbound" ? inboundRoomNumbers(roomName) : { callerNumber: "", calledNumber: "" };
  const toPhone = firstPhone(
    metadata.toPhone,
    variables.ToPhone,
    variables.toPhone,
    data.toPhone,
    data.ToPhone,
    data.calledPhone,
    data.CalledPhone,
    data.destinationPhone,
    data.DestinationPhone,
    roomNumbers.calledNumber,
    ...phonesByKey(variables, "to"),
    ...phonesByKey(data, "to"),
  );
  const fromPhone = firstPhoneWithContext(
    toPhone,
    metadata.fromPhone,
    variables.FromPhone,
    variables.fromPhone,
    data.fromPhone,
    data.FromPhone,
    data.callerPhone,
    data.CallerPhone,
    data.customerPhone,
    data.CustomerPhone,
    data.phone,
    data.Phone,
    roomNumbers.callerNumber,
    ...phonesByKey(variables, "from"),
    ...phonesByKey(data, "from"),
  );
  return {
    callerNumber: fromPhone,
    calledNumber: toPhone,
  };
}

function compactStructuredOutput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const compact = compactValue(item);
      return compact ? `${key}: ${compact}` : "";
    })
    .filter(Boolean)
    .slice(0, 8)
    .join("; ");
}

function compactTranscript(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .slice(-6)
    .map((item) => {
      const entry = item as { role?: unknown; text?: unknown };
      const role = compactValue(entry.role) || "speaker";
      const text = compactValue(entry.text);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join(" | ")
    .slice(0, 900);
}

function callerIdentifiers(input: {
  callDirection?: string;
  fromPhone?: string;
  toPhone?: string;
  metadata?: Record<string, unknown>;
}) {
  const candidates = [
    input.callDirection === "outbound" ? input.toPhone : input.fromPhone,
    input.callDirection === "outbound" ? input.fromPhone : input.toPhone,
    input.metadata?.phone,
    input.metadata?.Phone,
    input.metadata?.customerPhone,
    input.metadata?.CustomerPhone,
    input.metadata?.callerPhone,
    input.metadata?.CallerPhone,
  ];
  return [...new Set(candidates.map(compactValue).filter((value) => /\d{7,}/.test(value.replace(/\D/g, ""))))];
}

function readableError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function createCallRecord(input: {
  ownerId: string;
  agentId: string | Types.ObjectId;
  livekitRoomName: string;
  direction: "web" | "inbound" | "outbound";
  callerNumber?: string;
  calledNumber?: string;
  phoneNumberId?: string | Types.ObjectId;
  campaignId?: string | Types.ObjectId;
  campaignLeadId?: string | Types.ObjectId;
  pipelineMode?: "pipeline" | "realtime";
  realtimeProvider?: string;
  realtimeModel?: string;
  language?: string;
  llmProvider?: string;
  llmModel?: string;
  sttProvider?: string;
  sttModel?: string;
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
  outboundSetupPending?: boolean;
  outboundSetupToken?: string;
  outboundSetupStage?: "" | "starting" | "preparing" | "room_creating" | "room_created" | "dispatch_created" | "dialing" | "established" | "aborted" | "cleanup_required";
  outboundSetupStartedAt?: Date;
  outboundSetupCompletedAt?: Date;
}, options: { session?: ClientSession } = {}) {
  const call = await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: input.livekitRoomName },
    {
      $setOnInsert: {
        ...input,
        orgId: input.ownerId,
        status: input.direction === "outbound" ? "ringing" : "initiated",
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      ...(options.session ? { session: options.session } : {}),
    },
  );
  if (!call) throw new Error("Call record could not be created.");
  return call;
}

type CallRecordMetadataOptions = {
  authoritativeRuntime?: boolean;
};

export async function ensureCallRecordForRoom(
  roomName: string,
  metadata?: string,
  options: CallRecordMetadataOptions = {},
) {
  const parsed = parseMetadata(metadata);
  const direction = directionFromRoom(roomName);
  const authoritativeSnapshot = options.authoritativeRuntime
    ? effectiveModelSnapshot(parsed)
    : undefined;
  const existing = parsed.callId
    ? await CallDetailRecordModel.findById(parsed.callId)
    : await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  const numbers = metadataRouteNumbers(roomName, parsed);
  if (existing) {
    const update: Record<string, unknown> = {};
    if (numbers.callerNumber && !existing.callerNumber) update.callerNumber = numbers.callerNumber;
    if (numbers.calledNumber && !existing.calledNumber) update.calledNumber = numbers.calledNumber;
    if (options.authoritativeRuntime) {
      if (parsed.ownerId && String(existing.ownerId) !== parsed.ownerId) {
        throw new Error("Authoritative call runtime does not match the call owner.");
      }
      if (parsed.agentId && String(existing.agentId) !== parsed.agentId) {
        throw new Error("Authoritative call runtime does not match the call agent.");
      }
      Object.assign(update, authoritativeSnapshot);
    }
    if (Object.keys(update).length) {
      await CallDetailRecordModel.updateOne({ _id: existing._id }, { $set: update });
      Object.assign(existing, update);
    }
  }
  if (existing || !parsed.ownerId || !parsed.agentId) {
    return existing;
  }
  const call = await createCallRecord({
    ownerId: parsed.ownerId,
    agentId: parsed.agentId,
    livekitRoomName: roomName,
    direction,
    callerNumber: numbers.callerNumber,
    calledNumber: numbers.calledNumber,
    // Long-lived inbound route metadata is only a locator. Model fields are
    // written after the worker has loaded the authoritative MongoDB agent.
    ...(direction !== "inbound" || options.authoritativeRuntime
      ? effectiveModelSnapshot(parsed)
      : {}),
  });
  if (!authoritativeSnapshot) return call;

  // A LiveKit webhook and the worker can both observe a missing inbound call
  // record. If the webhook wins the upsert race, createCallRecord's
  // $setOnInsert cannot apply the refreshed model fields, so enforce them in a
  // second idempotent update before the worker starts the session.
  if (String(call.ownerId) !== parsed.ownerId) {
    throw new Error("Authoritative call runtime does not match the call owner.");
  }
  if (String(call.agentId) !== parsed.agentId) {
    throw new Error("Authoritative call runtime does not match the call agent.");
  }
  const authoritativeUpdate: Record<string, unknown> = { ...authoritativeSnapshot };
  if (numbers.callerNumber && !call.callerNumber) authoritativeUpdate.callerNumber = numbers.callerNumber;
  if (numbers.calledNumber && !call.calledNumber) authoritativeUpdate.calledNumber = numbers.calledNumber;
  await CallDetailRecordModel.updateOne({ _id: call._id }, { $set: authoritativeUpdate });
  Object.assign(call, authoritativeUpdate);
  return call;
}

const openCallStatuses = ["initiated", "ringing", "active"] as const;
const terminalCallStatuses = ["completed", "failed", "cancelled"] as const;
const terminalFinalizationLeaseMs = 10 * 60 * 1_000;

function terminalInputSchedule(now = new Date(), delayMs = env.callFinalizationSettleMs) {
  return {
    terminalFinalizationStatus: "pending",
    terminalFinalizationToken: "",
    terminalFinalizationLeaseUntil: null,
    terminalFinalizationError: "",
    terminalFinalizationDueAt: new Date(now.getTime() + Math.max(0, delayMs)),
  };
}

export async function markCallActive(
  roomName: string,
  metadata?: string,
  options: CallRecordMetadataOptions = {},
) {
  await ensureCallRecordForRoom(roomName, metadata, options);
  const now = new Date();
  // Set the first startedAt in the same atomic write as the active transition.
  // A later terminal CAS can therefore never persist endedAt before startedAt.
  const firstActivation = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $nin: ["completed", "failed", "cancelled"] },
      startedAt: null,
    },
    { $set: { status: "active", startedAt: now } },
    { new: true },
  );
  const call = firstActivation ?? await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName, status: { $nin: ["completed", "failed", "cancelled"] } },
    { $set: { status: "active" } },
    { new: true },
  );
  if (call) {
    void enqueueWebhookEvent(call.ownerId, "call.started", call.toObject(), call.id).catch(console.error);
  }
  return call;
}

export async function updateCallParticipant(
  roomName: string,
  participant: {
    identity?: string;
    name?: string;
    sid?: string;
    metadata?: string;
    attributes?: Record<string, string>;
  },
) {
  const attributes = participant.attributes ?? {};
  const parsed = parseMetadata(participant.metadata);
  const metadataNumbers = metadataRouteNumbers(roomName, parsed);
  const direction = parsed.callDirection || directionFromRoom(roomName);
  const sipPhone = phoneValue(attributes["sip.phoneNumber"]);
  const trunkPhone = phoneValue(attributes["sip.trunkPhoneNumber"]);
  const participantPhone = firstPhone(participant.name, participant.identity);
  const attributeFromPhone = firstPhone(
    attributes["sip.from"],
    attributes["sip.h.from"],
    attributes["sip.pAssertedIdentity"],
    attributes["sip.h.p-asserted-identity"],
    attributes["sip.pPreferredIdentity"],
    attributes["sip.h.p-preferred-identity"],
    attributes["sip.remotePartyId"],
    attributes["sip.h.remote-party-id"],
    ...phonesByKey(attributes, "from"),
  );
  const attributeToPhone = firstPhone(
    attributes["sip.to"],
    attributes["sip.h.to"],
    attributes["sip.diversion"],
    attributes["sip.h.diversion"],
    ...phonesByKey(attributes, "to"),
  );
  const update: Record<string, string> = {};
  if (participant.sid) update.livekitParticipantId = participant.sid;
  if (direction === "inbound") {
    const calledNumber = firstPhone(metadataNumbers.calledNumber, attributeToPhone, trunkPhone, inboundNumberFromRoom(roomName));
    const callerNumber = firstPhoneWithContext(calledNumber, sipPhone, attributeFromPhone, metadataNumbers.callerNumber, participantPhone);
    if (callerNumber) update.callerNumber = callerNumber;
    if (calledNumber) update.calledNumber = calledNumber;
    if (!callerNumber) {
      console.warn(JSON.stringify({
        event: "caller-id-not-received",
        roomName,
        participantIdentity: participant.identity ?? "",
        participantName: participant.name ?? "",
        candidateKeys: Object.keys(attributes),
        candidateAttributes: sanitizedAttributeSnapshot(attributes),
      }));
    }
  } else if (direction === "outbound") {
    const callerNumber = firstPhone(metadataNumbers.callerNumber, attributeFromPhone, trunkPhone);
    const calledNumber = firstPhone(sipPhone, attributeToPhone, metadataNumbers.calledNumber, participantPhone);
    if (callerNumber) update.callerNumber = callerNumber;
    if (calledNumber) update.calledNumber = calledNumber;
  } else {
    const callerNumber = firstPhone(metadataNumbers.callerNumber, attributeFromPhone, participantPhone);
    const calledNumber = firstPhone(metadataNumbers.calledNumber, attributeToPhone);
    if (callerNumber) update.callerNumber = callerNumber;
    if (calledNumber) update.calledNumber = calledNumber;
  }
  return CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName },
    { $set: update },
    { new: true },
  );
}

export async function appendTranscriptItem(input: {
  roomName: string;
  itemId: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: Date;
  interrupted?: boolean;
  dedupeText?: boolean;
  dedupeWindowMs?: number;
}) {
  const text = input.text.trim();
  if (!text) return null;
  const timestamp = input.timestamp ?? new Date();
  const interrupted = input.interrupted ?? false;
  const finalizationSchedule = terminalInputSchedule();
  const dedupeWindowMs = Math.max(0, input.dedupeWindowMs ?? 0);
  const windowStart = dedupeWindowMs ? new Date(timestamp.getTime() - dedupeWindowMs) : null;
  const windowEnd = dedupeWindowMs ? new Date(timestamp.getTime() + dedupeWindowMs) : null;
  const existing = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: input.roomName,
      transcript: {
        $elemMatch: {
          itemId: input.itemId,
          $or: [
            { text: { $ne: text } },
            { timestamp: { $ne: timestamp } },
            { interrupted: { $ne: interrupted } },
          ],
        },
      },
    },
    {
      $set: {
        "transcript.$.text": text,
        "transcript.$.timestamp": timestamp,
        "transcript.$.interrupted": interrupted,
        ...finalizationSchedule,
      },
      $inc: { terminalDataRevision: 1, billingUsageRevision: 1 },
    },
    { new: true },
  );
  if (existing) return existing;

  return CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: input.roomName,
      "transcript.itemId": { $ne: input.itemId },
      ...(input.dedupeText ? { transcript: { $not: { $elemMatch: { role: input.role, text } } } } : {}),
      ...(windowStart && windowEnd
        ? { transcript: { $not: { $elemMatch: { role: input.role, text, timestamp: { $gte: windowStart, $lte: windowEnd } } } } }
        : {}),
    },
    {
      $set: finalizationSchedule,
      $push: {
        transcript: {
          itemId: input.itemId,
          role: input.role,
          text,
          timestamp,
          interrupted,
        },
      },
      $inc: { terminalDataRevision: 1 },
    },
    { new: true },
  );
}

export async function updateCallRecording(input: {
  roomName?: string;
  egressId?: string;
  status: "starting" | "active" | "completed" | "failed";
  key?: string;
  url?: string;
  durationSeconds?: number;
  error?: string;
}) {
  const filters: Record<string, unknown>[] = [];
  if (input.egressId) filters.push({ recordingEgressId: input.egressId });
  if (input.roomName) filters.push({ livekitRoomName: input.roomName });
  if (!filters.length) return null;

  const $set: Record<string, unknown> = {
    recordingStatus: input.status,
    recordingError: input.error ?? "",
    ...terminalInputSchedule(),
  };
  if (input.egressId) $set.recordingEgressId = input.egressId;
  if (input.key) $set.recordingKey = input.key;
  if (input.url) $set.recordingUrl = input.url;
  const roundedDuration = typeof input.durationSeconds === "number"
    ? Math.max(0, Math.round(input.durationSeconds))
    : undefined;
  if (typeof roundedDuration === "number") $set.recordingDuration = roundedDuration;

  const identityFilter = filters.length === 1 ? filters[0] : { $or: filters };
  const recordingStateFilter = input.status === "starting"
    ? { recordingStatus: { $in: ["", "starting"] } }
    : input.status === "active"
      ? { recordingStatus: { $nin: ["completed", "failed"] } }
      : {};
  const changedFilters: Record<string, unknown>[] = [
    { recordingStatus: { $ne: input.status } },
    { recordingError: { $ne: input.error ?? "" } },
  ];
  if (input.egressId) changedFilters.push({ recordingEgressId: { $ne: input.egressId } });
  if (input.key) changedFilters.push({ recordingKey: { $ne: input.key } });
  if (input.url) changedFilters.push({ recordingUrl: { $ne: input.url } });
  if (typeof roundedDuration === "number") changedFilters.push({ recordingDuration: { $ne: roundedDuration } });

  return CallDetailRecordModel.findOneAndUpdate(
    { $and: [identityFilter, recordingStateFilter, { $or: changedFilters }] },
    { $set, $inc: { terminalDataRevision: 1 } },
    { new: true },
  );
}

export async function recordCallLatency(roomName: string, latencyMs: number) {
  const rounded = Math.round(latencyMs);
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > 60000) return;
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName }).select(
    "+latencyTotalMs +latencySampleCount",
  );
  if (!call) return;
  call.latencyTotalMs += rounded;
  call.latencySampleCount += 1;
  call.avgResponseLatencyMs = Math.round(call.latencyTotalMs / call.latencySampleCount);
  await call.save();
}

export async function markVoicemailDetected(roomName: string) {
  return CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName },
    {
      $set: { voicemailDetected: true },
      $addToSet: { tags: "voicemail" },
    },
    { new: true },
  );
}

export async function markDoNotCallDetected(roomName: string, phrase = "") {
  const trimmedPhrase = phrase.trim().slice(0, 500);
  const $set: Record<string, unknown> = {
    "structuredOutput.doNotCallDetected": true,
    "structuredOutput.doNotCallDetectedAt": new Date(),
  };
  if (trimmedPhrase) {
    $set["structuredOutput.doNotCallPhrase"] = trimmedPhrase;
  }

  return CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName },
    {
      $set,
      $addToSet: { tags: { $each: ["do_not_call", "opt_out"] } },
    },
    { new: true },
  );
}

export async function getPreviousCallerContext(input: {
  ownerId: string;
  agentId: string;
  callId?: string;
  callDirection?: string;
  fromPhone?: string;
  toPhone?: string;
  metadata?: Record<string, unknown>;
  includeMemory?: boolean;
  limit?: number;
}) {
  const identifiers = callerIdentifiers(input);
  if (!input.ownerId || !input.agentId || !identifiers.length) {
    return { identifier: "", previousCallCount: 0, lines: [] as string[] };
  }

  const filter: Record<string, unknown> = {
    ownerId: input.ownerId,
    agentId: input.agentId,
    status: { $in: ["completed", "failed"] },
    $or: [
      { callerNumber: { $in: identifiers } },
      { calledNumber: { $in: identifiers } },
    ],
  };
  if (input.callId && /^[a-f0-9]{24}$/i.test(input.callId)) {
    filter._id = { $ne: input.callId };
  }

  const limit = Math.min(5, Math.max(1, input.limit ?? 3));
  const [previousCallCount, calls] = await Promise.all([
    CallDetailRecordModel.countDocuments(filter),
    CallDetailRecordModel.find(filter)
      .sort({ startedAt: -1, endedAt: -1, createdAt: -1 })
      .limit(limit)
      .select("startedAt direction status durationSeconds endReason tags structuredOutput transcript callerNumber calledNumber")
      .lean(),
  ]);

  const lines = calls.map((call) => {
    const tags = Array.isArray(call.tags) && call.tags.length ? `, tags: ${call.tags.slice(0, 6).join(", ")}` : "";
    const endReason = compactValue(call.endReason);
    const base = `${readableDate(call.startedAt)}: ${call.direction} call, ${call.status}, ${call.durationSeconds ?? 0}s${endReason ? `, ended: ${endReason}` : ""}${tags}`;
    if (!input.includeMemory) return `- ${base}`;

    const details = compactStructuredOutput(call.structuredOutput);
    const transcript = compactTranscript(call.transcript);
    return [
      `- ${base}`,
      details ? `saved details: ${details}` : "",
      transcript ? `recent transcript: ${transcript}` : "",
    ].filter(Boolean).join("; ").slice(0, 1400);
  });

  return { identifier: identifiers[0], previousCallCount, lines };
}

export async function recordCallUsage(
  roomName: string,
  usage: {
    modelUsage: Array<
      Partial<{
        type: string;
        provider: string;
        model: string;
        inputTokens: number;
        inputCachedTokens: number;
        inputAudioTokens: number;
        inputCachedAudioTokens: number;
        inputTextTokens: number;
        inputCachedTextTokens: number;
        inputImageTokens: number;
        inputCachedImageTokens: number;
        outputTokens: number;
        outputAudioTokens: number;
        outputTextTokens: number;
        sessionDurationMs: number;
        charactersCount: number;
        audioDurationMs: number;
      }>
    >;
  },
) {
  let llmTokens = 0;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let llmProvider = "";
  let llmModel = "";
  let sttSeconds = 0;
  let sttInputTokens = 0;
  let sttOutputTokens = 0;
  let sttProvider = "";
  let sttModel = "";
  let ttsCharacters = 0;
  let ttsAudioSeconds = 0;
  let ttsInputTokens = 0;
  let ttsOutputTokens = 0;
  let ttsProvider = "";
  let ttsModel = "";

  const cleanUsage = usage.modelUsage
    .map((item) => {
      const clean: Record<string, string | number> = {};
      for (const field of ["type", "provider", "model"] as const) {
        const value = typeof item[field] === "string" ? item[field]?.trim() : "";
        if (value && value.toLowerCase() !== "unknown") {
          clean[field] = field === "provider" ? canonicalPricingProvider(value) : value;
        }
      }
      for (const field of [
        "inputTokens",
        "inputCachedTokens",
        "inputAudioTokens",
        "inputCachedAudioTokens",
        "inputTextTokens",
        "inputCachedTextTokens",
        "inputImageTokens",
        "inputCachedImageTokens",
        "outputTokens",
        "outputAudioTokens",
        "outputTextTokens",
        "sessionDurationMs",
        "charactersCount",
        "audioDurationMs",
      ] as const) {
        const value = Number(item[field] ?? 0);
        if (Number.isFinite(value) && value > 0) clean[field] = value;
      }
      return clean;
    })
    .filter((item) => typeof item.type === "string");

  for (const item of cleanUsage) {
    if (item.type === "llm_usage") {
      llmInputTokens += Number(item.inputTokens ?? 0);
      llmOutputTokens += Number(item.outputTokens ?? 0);
      llmProvider = typeof item.provider === "string" ? item.provider : llmProvider;
      llmModel = typeof item.model === "string" ? item.model : llmModel;
    } else if (item.type === "stt_usage") {
      sttSeconds += Number(item.audioDurationMs ?? 0) / 1000;
      sttInputTokens += Number(item.inputTokens ?? 0);
      sttOutputTokens += Number(item.outputTokens ?? 0);
      sttProvider = typeof item.provider === "string" ? item.provider : sttProvider;
      sttModel = typeof item.model === "string" ? item.model : sttModel;
    } else if (item.type === "tts_usage") {
      ttsCharacters += Number(item.charactersCount ?? 0);
      ttsAudioSeconds += Number(item.audioDurationMs ?? 0) / 1000;
      ttsInputTokens += Number(item.inputTokens ?? 0);
      ttsOutputTokens += Number(item.outputTokens ?? 0);
      ttsProvider = typeof item.provider === "string" ? item.provider : ttsProvider;
      ttsModel = typeof item.model === "string" ? item.model : ttsModel;
    }
  }
  llmTokens = llmInputTokens + llmOutputTokens;

  const modelUpdates = {
    ...(llmProvider ? { llmProvider } : {}),
    ...(llmModel ? { llmModel } : {}),
    ...(sttProvider ? { sttProvider } : {}),
    ...(sttModel ? { sttModel } : {}),
    ...(ttsProvider ? { ttsProvider } : {}),
    ...(ttsModel ? { ttsModel } : {}),
  };

  const call = await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName, modelUsage: { $ne: cleanUsage } },
    {
      $set: {
        ...modelUpdates,
        ...terminalInputSchedule(),
        modelUsage: cleanUsage,
        llmInputTokens,
        llmOutputTokens,
        llmTokens,
        sttInputTokens,
        sttOutputTokens,
        sttSeconds: Math.round(sttSeconds * 100) / 100,
        ttsInputTokens,
        ttsOutputTokens,
        ttsAudioSeconds: Math.round(ttsAudioSeconds * 100) / 100,
        ttsCharacters,
      },
      $inc: { terminalDataRevision: 1 },
    },
    { new: true },
  );
  return call;
}

/** Mark the agent SDK event stream as flushed after its Close callback has
 * awaited every queued transcript and usage write. Finalization also has a
 * bounded fallback for failures that occur before a session can be created. */
export async function markCallRuntimeInputsClosed(roomName: string) {
  const now = new Date();
  return CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $in: terminalCallStatuses },
      $or: [
        { terminalRuntimeClosedAt: { $exists: false } },
        { terminalRuntimeClosedAt: null },
      ],
    },
    {
      $set: {
        terminalRuntimeClosedAt: now,
        ...terminalInputSchedule(now),
      },
    },
    { new: true },
  );
}

function terminalFinalizationPending(deferred = false) {
  const now = new Date();
  return {
    ...terminalInputSchedule(now),
    terminalFinalizationAttempts: 0,
    terminalFinalizationDeferred: deferred,
    terminalFinalizedDataRevision: 0,
    terminalRuntimeClosedAt: null,
    terminalFinalizedAt: null,
  };
}

async function persistTerminalDuration(
  call: {
    _id: Types.ObjectId;
    status: string;
    startedAt?: Date | null;
  },
  endedAt: Date,
) {
  const updated = await CallDetailRecordModel.findOneAndUpdate(
    { _id: call._id, status: call.status },
    { $set: { durationSeconds: durationSeconds(call.startedAt, endedAt) } },
    { new: true },
  );
  return updated ?? CallDetailRecordModel.findById(call._id);
}

async function ensureTerminalMetrics(call: {
  _id: Types.ObjectId;
  status: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
}) {
  const now = new Date();
  const endedAt = call.startedAt && (!call.endedAt || call.startedAt > call.endedAt)
    ? call.startedAt
    : call.endedAt ?? now;
  const duration = durationSeconds(call.startedAt, endedAt);
  return CallDetailRecordModel.findOneAndUpdate(
    { _id: call._id, status: call.status },
    { $set: { endedAt, durationSeconds: duration } },
    { new: true },
  );
}

function dispatchImmediateTerminalWebhook(call: {
  id?: string;
  ownerId: unknown;
  toObject(): Record<string, unknown>;
}) {
  const payload = call.toObject();
  const callId = String(call.id ?? payload._id ?? "").trim();
  if (!callId) return;
  void enqueueWebhookEvent(
    String(call.ownerId),
    "call.ended",
    payload,
    `${callId}:immediate`,
  ).catch((error) => {
    console.error(JSON.stringify({
      event: "immediate-call-ended-webhook-failed",
      callId,
      error: readableError(error),
    }));
  });
}

/**
 * Claim and run terminal side effects from the durable due queue. Request and
 * LiveKit webhook paths only persist queue state; they never run analysis,
 * billing, provider webhooks, or integrations inline. The revision claim is
 * invalidated atomically by every late terminal input.
 */
export async function finalizeTerminalCall(roomName: string) {
  const now = new Date();
  const token = randomUUID();
  const call = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $in: terminalCallStatuses },
      terminalFinalizationDeferred: { $ne: true },
      $or: [
        {
          $and: [
            {
              $or: [
                { terminalFinalizationStatus: { $exists: false } },
                { terminalFinalizationStatus: { $in: ["", "pending", "failed"] } },
              ],
            },
            {
              $or: [
                { terminalFinalizationDueAt: { $exists: false } },
                { terminalFinalizationDueAt: null },
                { terminalFinalizationDueAt: { $lte: now } },
              ],
            },
          ],
        },
        {
          terminalFinalizationStatus: "processing",
          terminalFinalizationLeaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        terminalFinalizationStatus: "processing",
        terminalFinalizationToken: token,
        terminalFinalizationLeaseUntil: new Date(now.getTime() + terminalFinalizationLeaseMs),
        terminalFinalizationError: "",
      },
      $inc: { terminalFinalizationAttempts: 1 },
    },
    { new: true },
  ).select(
    "+terminalFinalizationToken +terminalFinalizationAttempts +terminalDataRevision +terminalFinalizationDueAt +terminalRuntimeClosedAt",
  );

  if (!call) {
    return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  }

  const expectedRevision = call.terminalDataRevision ?? 0;
  const ownsRevision = () => CallDetailRecordModel.findOne({
    _id: call._id,
    status: { $in: terminalCallStatuses },
    terminalFinalizationStatus: "processing",
    terminalFinalizationToken: token,
    terminalDataRevision: expectedRevision,
  }).select("+terminalFinalizationToken +terminalDataRevision +billingUsageRevision +postCallIntegrationsDispatchedAt");

  try {
    const measured = await ensureTerminalMetrics(call);
    if (!measured) throw new Error("Call record disappeared during terminal finalization.");

    if (!call.terminalRuntimeClosedAt) {
      const runtimeDeadline = new Date(
        (measured.endedAt ?? now).getTime() + env.callRuntimeFinalizationWaitMs,
      );
      if (runtimeDeadline > now) {
        const retryAt = new Date(Math.min(runtimeDeadline.getTime(), now.getTime() + 15_000));
        await CallDetailRecordModel.updateOne(
          {
            _id: call._id,
            terminalFinalizationStatus: "processing",
            terminalFinalizationToken: token,
            terminalDataRevision: expectedRevision,
          },
          {
            $set: {
              terminalFinalizationStatus: "pending",
              terminalFinalizationToken: "",
              terminalFinalizationLeaseUntil: null,
              terminalFinalizationDueAt: retryAt,
              terminalFinalizationError: "",
            },
          },
        );
        return measured;
      }
    }

    if (measured.recordingStatus === "starting" || measured.recordingStatus === "active") {
      const terminalAt = measured.endedAt ?? now;
      const recordingDeadline = new Date(terminalAt.getTime() + env.callRecordingFinalizationWaitMs);
      if (recordingDeadline > now) {
        const retryAt = new Date(Math.min(recordingDeadline.getTime(), now.getTime() + 30_000));
        await CallDetailRecordModel.updateOne(
          {
            _id: call._id,
            terminalFinalizationStatus: "processing",
            terminalFinalizationToken: token,
            terminalDataRevision: expectedRevision,
          },
          {
            $set: {
              terminalFinalizationStatus: "pending",
              terminalFinalizationToken: "",
              terminalFinalizationLeaseUntil: null,
              terminalFinalizationDueAt: retryAt,
              terminalFinalizationError: "",
            },
          },
        );
        return measured;
      }

      // Never manufacture a successful recording. If LiveKit never delivers
      // egress_ended, finalize after the bounded wait with an explicit failure;
      // a genuinely late terminal egress event will reopen the queue safely.
      await CallDetailRecordModel.updateOne(
        {
          _id: call._id,
          terminalFinalizationStatus: "processing",
          terminalFinalizationToken: token,
          terminalDataRevision: expectedRevision,
          recordingStatus: { $in: ["starting", "active"] },
        },
        {
          $set: {
            recordingStatus: "failed",
            recordingError: "Recording egress did not reach a terminal state before the finalization deadline.",
          },
        },
      );
    }

    await finalizeCallIntelligence(roomName, {
      terminalDataRevision: expectedRevision,
      terminalFinalizationToken: token,
    });
    let enriched = await ownsRevision();
    if (!enriched) {
      return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
    }

    await deductCreditsForCall({
      id: enriched.id,
      ownerId: enriched.ownerId,
      durationSeconds: enriched.durationSeconds,
      llmTokens: enriched.llmTokens,
      sttSeconds: enriched.sttSeconds,
      ttsCharacters: enriched.ttsCharacters,
      billingUsageRevision: enriched.billingUsageRevision ?? 0,
      costBreakdown: enriched.costBreakdown ?? undefined,
    });

    // Billing is transactionally retry-safe, but a newer usage event means the
    // webhook payload must be regenerated on the next queue attempt.
    enriched = await ownsRevision();
    if (!enriched) {
      return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
    }
    const payload = enriched.toObject();
    const stagedGroups = await Promise.all([
      ...(enriched.status === "failed"
        ? [stageWebhookEvent(enriched.ownerId, "call.failed", payload, enriched.id)]
        : []),
      stageWebhookEvent(enriched.ownerId, "call.ended", payload, enriched.id),
      ...(enriched.transcript.length
        ? [stageWebhookEvent(enriched.ownerId, "transcript.ready", payload, enriched.id)]
        : []),
    ]);
    const stagedDeliveryIds = stagedGroups
      .flatMap((deliveries) => deliveries.map((delivery) => delivery?.id ?? ""))
      .filter(Boolean);
    const stagedIntegrationDeliveries = await stagePostCallIntegrations(enriched.ownerId, payload);
    const stagedIntegrationDeliveryIds = stagedIntegrationDeliveries
      .map((delivery) => delivery?.id ?? "")
      .filter(Boolean);

    const completedAt = new Date();
    const completionSession = await startSession();
    let completed = false;
    try {
      await completionSession.withTransaction(async () => {
        completed = false;
        const completion = await CallDetailRecordModel.updateOne(
          {
            _id: call._id,
            status: { $in: terminalCallStatuses },
            terminalFinalizationStatus: "processing",
            terminalFinalizationToken: token,
            terminalDataRevision: expectedRevision,
          },
          {
            $set: {
              terminalFinalizationStatus: "completed",
              terminalFinalizedAt: completedAt,
              terminalFinalizedDataRevision: expectedRevision,
              terminalFinalizationToken: "",
              terminalFinalizationLeaseUntil: null,
              terminalFinalizationDueAt: null,
              terminalFinalizationError: "",
              terminalFinalizationDeferred: false,
            },
          },
          { session: completionSession },
        );
        if (completion.matchedCount !== 1) return;
        await activateStagedWebhookEvents(stagedDeliveryIds, { session: completionSession });
        await activateStagedIntegrationDeliveries(stagedIntegrationDeliveryIds, { session: completionSession });
        completed = true;
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
    } finally {
      await completionSession.endSession();
    }
    if (!completed) {
      return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
    }

    enriched.terminalFinalizedAt = completedAt;
    return enriched;
  } catch (error) {
    const attempts = Math.max(1, call.terminalFinalizationAttempts ?? 1);
    const retryDelayMs = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(6, attempts - 1));
    await CallDetailRecordModel.updateOne(
      {
        _id: call._id,
        terminalFinalizationStatus: "processing",
        terminalFinalizationToken: token,
        terminalDataRevision: expectedRevision,
      },
      {
        $set: {
          terminalFinalizationStatus: "failed",
          terminalFinalizationToken: "",
          terminalFinalizationLeaseUntil: null,
          terminalFinalizationDueAt: new Date(Date.now() + retryDelayMs),
          terminalFinalizationError: readableError(error),
        },
      },
    ).catch(() => undefined);
    throw error;
  }
}

export async function completeCall(roomName: string, endReason = "completed") {
  const endedAt = new Date();
  const call = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $in: openCallStatuses },
    },
    {
      $set: {
        status: "completed",
        endedAt,
        endReason,
        ...terminalFinalizationPending(),
      },
      $inc: { terminalDataRevision: 1 },
    },
    { new: true },
  );
  if (!call) return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  const persisted = await persistTerminalDuration(call, endedAt);
  if (persisted) dispatchImmediateTerminalWebhook(persisted);
  return persisted;
}

export async function failCall(roomName: string, error: unknown, endReason = "error") {
  const endedAt = new Date();
  const call = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $in: openCallStatuses },
    },
    {
      $set: {
        status: "failed",
        endedAt,
        endReason,
        errorMessage: readableError(error),
        ...terminalFinalizationPending(),
      },
      $inc: { terminalDataRevision: 1 },
    },
    { new: true },
  );
  if (!call) return CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  const persisted = await persistTerminalDuration(call, endedAt);
  if (persisted) dispatchImmediateTerminalWebhook(persisted);
  return persisted;
}

export async function transitionCallToCancelled(
  roomName: string,
  endReason = "cancelled",
  options: { deferFinalizationUntilRoomClosed?: boolean } = {},
) {
  const endedAt = new Date();
  const call = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: roomName,
      status: { $in: openCallStatuses },
    },
    {
      $set: {
        status: "cancelled",
        endedAt,
        endReason,
        ...terminalFinalizationPending(Boolean(options.deferFinalizationUntilRoomClosed)),
      },
      $inc: { terminalDataRevision: 1 },
    },
    { new: true },
  );
  if (!call) return null;
  const persisted = await persistTerminalDuration(call, endedAt);
  if (persisted) dispatchImmediateTerminalWebhook(persisted);
  return persisted;
}

export async function releaseTerminalFinalizationDeferral(roomName: string) {
  const now = new Date();
  return CallDetailRecordModel.updateOne(
    {
      livekitRoomName: roomName,
      status: { $in: terminalCallStatuses },
      terminalFinalizationDeferred: true,
    },
    {
      $set: {
        terminalFinalizationDeferred: false,
        ...terminalInputSchedule(now),
      },
    },
  );
}

export async function cancelCall(roomName: string, endReason = "cancelled") {
  const call = await transitionCallToCancelled(roomName, endReason);
  return call ?? CallDetailRecordModel.findOne({ livekitRoomName: roomName });
}

export async function processPendingCallFinalizations(limit = 50) {
  const now = new Date();
  const calls = await CallDetailRecordModel.find({
    status: { $in: terminalCallStatuses },
    terminalFinalizationDeferred: { $ne: true },
    $or: [
      {
        terminalFinalizationStatus: { $exists: false },
        $or: [
          { terminalFinalizationDueAt: { $exists: false } },
          { terminalFinalizationDueAt: null },
          { terminalFinalizationDueAt: { $lte: now } },
        ],
      },
      {
        terminalFinalizationStatus: { $in: ["pending", "failed"] },
        $or: [
          { terminalFinalizationDueAt: { $exists: false } },
          { terminalFinalizationDueAt: null },
          { terminalFinalizationDueAt: { $lte: now } },
        ],
      },
      {
        terminalFinalizationStatus: "processing",
        terminalFinalizationLeaseUntil: { $lte: now },
      },
    ],
  })
    .select("livekitRoomName")
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(limit, 200)))
    .lean();
  let failed = 0;
  const concurrency = env.callFinalizationConcurrency;
  for (let index = 0; index < calls.length; index += concurrency) {
    const results = await Promise.allSettled(
      calls.slice(index, index + concurrency).map((call) => finalizeTerminalCall(call.livekitRoomName)),
    );
    failed += results.filter((result) => result.status === "rejected").length;
  }
  if (failed) {
    console.error(JSON.stringify({
      event: "terminal-call-finalization-retry-failed",
      attempted: calls.length,
      failed,
    }));
  }
  return { attempted: calls.length, completed: calls.length - failed, failed };
}
