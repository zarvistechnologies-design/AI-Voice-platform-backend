import type { Types } from "mongoose";

import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { enqueueWebhookEvent } from "./outboundWebhookService.js";
import { runPostCallIntegrations } from "./integrationService.js";
import { finalizeCallIntelligence } from "./callIntelligenceService.js";

export type CallMetadata = {
  callId?: string;
  ownerId?: string;
  agentId?: string;
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
  llmProvider?: string;
  llmModel?: string;
  sttProvider?: string;
  sttModel?: string;
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
}) {
  const call = await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: input.livekitRoomName },
    {
      $setOnInsert: {
        ...input,
        orgId: input.ownerId,
        status: input.direction === "outbound" ? "ringing" : "initiated",
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
  if (!call) throw new Error("Call record could not be created.");
  return call;
}

export async function ensureCallRecordForRoom(roomName: string, metadata?: string) {
  const parsed = parseMetadata(metadata);
  const existing = parsed.callId
    ? await CallDetailRecordModel.findById(parsed.callId)
    : await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  if (existing || !parsed.ownerId || !parsed.agentId) {
    return existing;
  }
  return createCallRecord({
    ownerId: parsed.ownerId,
    agentId: parsed.agentId,
    livekitRoomName: roomName,
    direction: directionFromRoom(roomName),
    llmProvider: parsed.llmProvider,
    llmModel: parsed.llmModel,
    sttProvider: parsed.sttProvider,
    sttModel: parsed.sttModel,
    ttsProvider: parsed.ttsProvider,
    ttsModel: parsed.ttsModel,
    ttsVoice: parsed.ttsVoice,
  });
}

export async function markCallActive(roomName: string, metadata?: string) {
  await ensureCallRecordForRoom(roomName, metadata);
  const now = new Date();
  const call = await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName, status: { $nin: ["completed", "failed", "cancelled"] } },
    {
      $set: { status: "active" },
      $setOnInsert: { startedAt: now },
    },
    { new: true },
  ).then(async (call) => {
    if (call && !call.startedAt) {
      call.startedAt = now;
      await call.save();
    }
    if (call) {
      void enqueueWebhookEvent(call.ownerId, "call.started", call.toObject(), call.id).catch(console.error);
    }
    return call;
  });
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
  const phone =
    attributes["sip.phoneNumber"] ??
    attributes["sip.trunkPhoneNumber"] ??
    participant.name ??
    "";
  const update: Record<string, string> = {};
  if (participant.sid) update.livekitParticipantId = participant.sid;
  if (phone.startsWith("+")) {
    if (roomName.startsWith("inbound-")) update.callerNumber = phone;
    if (roomName.startsWith("outbound-call-")) update.calledNumber = phone;
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
}) {
  const text = input.text.trim();
  if (!text) return null;
  const timestamp = input.timestamp ?? new Date();
  const interrupted = input.interrupted ?? false;
  const existing = await CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: input.roomName,
      "transcript.itemId": input.itemId,
    },
    {
      $set: {
        "transcript.$.text": text,
        "transcript.$.timestamp": timestamp,
        "transcript.$.interrupted": interrupted,
      },
    },
    { new: true },
  );
  if (existing) return existing;

  return CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: input.roomName,
      "transcript.itemId": { $ne: input.itemId },
      ...(input.dedupeText ? { transcript: { $not: { $elemMatch: { role: input.role, text } } } } : {}),
    },
    {
      $push: {
        transcript: {
          itemId: input.itemId,
          role: input.role,
          text,
          timestamp,
          interrupted,
        },
      },
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

  const $set: Record<string, string | number> = {
    recordingStatus: input.status,
    recordingError: input.error ?? "",
  };
  if (input.egressId) $set.recordingEgressId = input.egressId;
  if (input.key) $set.recordingKey = input.key;
  if (input.url) $set.recordingUrl = input.url;
  if (typeof input.durationSeconds === "number") $set.recordingDuration = Math.max(0, Math.round(input.durationSeconds));

  return CallDetailRecordModel.findOneAndUpdate(
    filters.length === 1 ? filters[0] : { $or: filters },
    { $set },
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
        if (value && value.toLowerCase() !== "unknown") clean[field] = value;
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
    { livekitRoomName: roomName },
    {
      $set: {
        ...modelUpdates,
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
    },
    { new: true },
  );
  if (call?.status === "completed" || call?.status === "failed") return finalizeCallIntelligence(roomName);
  return call;
}

export async function completeCall(roomName: string, endReason = "completed") {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  if (!call || ["completed", "failed", "cancelled"].includes(call.status)) return call;
  const endedAt = new Date();
  call.status = "completed";
  call.endedAt = endedAt;
  call.durationSeconds = durationSeconds(call.startedAt, endedAt);
  call.endReason = endReason;
  await call.save();
  await finalizeCallIntelligence(roomName);
  const enriched = (await CallDetailRecordModel.findOne({ livekitRoomName: roomName })) ?? call;
  void enqueueWebhookEvent(enriched.ownerId, "call.ended", enriched.toObject(), enriched.id).catch(console.error);
  if (enriched.transcript.length) {
    void enqueueWebhookEvent(enriched.ownerId, "transcript.ready", enriched.toObject(), enriched.id).catch(console.error);
  }
  void runPostCallIntegrations(enriched.ownerId, enriched.toObject()).catch(console.error);
  return enriched;
}

export async function failCall(roomName: string, error: unknown) {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  if (!call) return null;
  const endedAt = new Date();
  call.status = "failed";
  call.endedAt = endedAt;
  call.durationSeconds = durationSeconds(call.startedAt, endedAt);
  call.endReason = "error";
  call.errorMessage = readableError(error);
  await call.save();
  await finalizeCallIntelligence(roomName);
  void enqueueWebhookEvent(call.ownerId, "call.failed", call.toObject(), call.id).catch(console.error);
  void enqueueWebhookEvent(call.ownerId, "call.ended", call.toObject(), call.id).catch(console.error);
  return call;
}
