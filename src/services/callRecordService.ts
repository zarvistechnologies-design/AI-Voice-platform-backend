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
  sttProvider?: string;
  ttsProvider?: string;
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

export async function createCallRecord(input: {
  ownerId: string;
  agentId: string | Types.ObjectId;
  livekitRoomName: string;
  direction: "web" | "inbound" | "outbound";
  callerNumber?: string;
  calledNumber?: string;
  phoneNumberId?: string | Types.ObjectId;
  llmProvider?: string;
  sttProvider?: string;
  ttsProvider?: string;
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
    sttProvider: parsed.sttProvider,
    ttsProvider: parsed.ttsProvider,
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
}) {
  const text = input.text.trim();
  if (!text) return null;
  return CallDetailRecordModel.findOneAndUpdate(
    {
      livekitRoomName: input.roomName,
      "transcript.itemId": { $ne: input.itemId },
    },
    {
      $push: {
        transcript: {
          itemId: input.itemId,
          role: input.role,
          text,
          timestamp: input.timestamp ?? new Date(),
          interrupted: input.interrupted ?? false,
        },
      },
    },
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

export async function recordCallUsage(
  roomName: string,
  usage: {
    modelUsage: Array<
      Partial<{
        type: string;
        provider: string;
        inputTokens: number;
        outputTokens: number;
        charactersCount: number;
        audioDurationMs: number;
      }>
    >;
  },
) {
  let llmTokens = 0;
  let sttSeconds = 0;
  let ttsCharacters = 0;
  let llmProvider = "";
  let sttProvider = "";
  let ttsProvider = "";

  for (const item of usage.modelUsage) {
    if (item.type === "llm_usage") {
      llmTokens += (item.inputTokens ?? 0) + (item.outputTokens ?? 0);
      llmProvider ||= item.provider ?? "";
    } else if (item.type === "stt_usage") {
      sttSeconds += (item.audioDurationMs ?? 0) / 1000;
      sttProvider ||= item.provider ?? "";
    } else if (item.type === "tts_usage") {
      ttsCharacters += item.charactersCount ?? 0;
      ttsProvider ||= item.provider ?? "";
    }
  }

  const call = await CallDetailRecordModel.findOneAndUpdate(
    { livekitRoomName: roomName },
    {
      $set: {
        llmTokens,
        sttSeconds: Math.round(sttSeconds * 100) / 100,
        ttsCharacters,
        ...(llmProvider ? { llmProvider } : {}),
        ...(sttProvider ? { sttProvider } : {}),
        ...(ttsProvider ? { ttsProvider } : {}),
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
  call.errorMessage = error instanceof Error ? error.message : String(error);
  await call.save();
  await finalizeCallIntelligence(roomName);
  void enqueueWebhookEvent(call.ownerId, "call.failed", call.toObject(), call.id).catch(console.error);
  void enqueueWebhookEvent(call.ownerId, "call.ended", call.toObject(), call.id).catch(console.error);
  return call;
}
