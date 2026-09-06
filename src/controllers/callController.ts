import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { Request, Response } from "express";
import { isValidObjectId, Types } from "mongoose";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { creditBillingSettings } from "../services/billingService.js";
import {
    calculateCallCost,
    canonicalPricingProvider,
    MODEL_PRICING_VERSION,
} from "../services/modelPricingService.js";
import { effectiveCallLanguage } from "../services/callRecordService.js";
import { dedupeLegacyUserTranscriptItems } from "../services/transcriptDeduplication.js";
import {
    defaultGeminiRealtimeModel,
    defaultOpenAIRealtimeModel,
    normalizeGeminiRealtimeModel,
    normalizeOpenAIRealtimeModel,
} from "../services/modelCatalog.js";
import {
    getRecordingObject,
    recordingPrefix,
    recordingPublicUrl,
    recordingS3ConfigError,
    recordingS3Configured,
    uploadRecordingObject,
} from "../services/recordingStorageService.js";
import { HttpError } from "../utils/httpError.js";
import {
  recordingAccessExpires,
  signRecordingAccess,
  verifyRecordingAccess,
} from "../utils/recordingAccess.js";

function ownerId(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function escapeCsv(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordingRoot() {
  return path.resolve(process.cwd(), env.webRecordingStorageDir || "recordings");
}

function normalizedContentType(value: unknown) {
  return String(value ?? "audio/webm").split(";")[0]?.trim().toLowerCase() || "audio/webm";
}

function recordingExtension(contentType: string) {
  if (contentType === "audio/mp4" || contentType === "video/mp4") return "m4a";
  if (contentType === "audio/mpeg") return "mp3";
  if (contentType === "audio/ogg" || contentType === "application/ogg") return "ogg";
  return "webm";
}

function recordingMimeType(key: string) {
  const extension = path.extname(key).toLowerCase();
  if (extension === ".m4a" || extension === ".mp4") return "audio/mp4";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg") return "audio/ogg";
  return "audio/webm";
}

function resolveRecordingPath(key: string) {
  const normalizedKey = key.replaceAll("\\", "/");
  if (!normalizedKey.startsWith("web/")) throw new HttpError(404, "Local recording file not found.");

  const root = recordingRoot();
  const resolved = path.resolve(root, normalizedKey);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSeparator)) {
    throw new HttpError(400, "Invalid recording path.");
  }
  return resolved;
}

function webRecordingKey(callId: string, extension: string) {
  const safeCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${recordingPrefix()}/web/${safeCallId}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
}

function absoluteApiUrl(request: AuthenticatedRequest, pathname: string) {
  const brandedOrigin = request.whiteLabel?.linkOrigin || request.whiteLabel?.apiOrigin;
  if (brandedOrigin) return `${brandedOrigin.replace(/\/$/, "")}${pathname}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || request.protocol;
  const host = request.get("host") || `localhost:${env.port}`;
  return `${protocol}://${host}${pathname}`;
}

function durationSecondsFromHeader(value: unknown) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
}

function callFilters(request: AuthenticatedRequest) {
  const filters: Record<string, unknown> = { ownerId: ownerId(request) };
  const andFilters: Record<string, unknown>[] = [];
  if (typeof request.query.agentId === "string" && request.query.agentId) {
    filters.agentId = request.query.agentId;
  }
  if (typeof request.query.status === "string" && request.query.status) {
    filters.status = request.query.status;
  }
  if (typeof request.query.direction === "string" && request.query.direction) {
    filters.direction = request.query.direction;
  }
  if (typeof request.query.sentiment === "string" && request.query.sentiment) {
    filters.sentimentLabel = request.query.sentiment;
  }
  const duration: Record<string, number> = {};
  if (Number.isFinite(Number(request.query.minDuration))) duration.$gte = Math.max(0, Number(request.query.minDuration));
  if (Number.isFinite(Number(request.query.maxDuration)) && request.query.maxDuration !== "") duration.$lte = Math.max(0, Number(request.query.maxDuration));
  if (Object.keys(duration).length) filters.durationSeconds = duration;
  if (typeof request.query.search === "string" && request.query.search.trim()) {
    const regex = new RegExp(escapeRegex(request.query.search.trim()), "i");
    andFilters.push({ $or: [{ "transcript.text": regex }, { callerNumber: regex }, { calledNumber: regex }, { tags: regex }] });
  }
  if (typeof request.query.phoneNumber === "string" && request.query.phoneNumber.trim()) {
    const regex = new RegExp(escapeRegex(request.query.phoneNumber.trim()), "i");
    andFilters.push({ $or: [{ callerNumber: regex }, { calledNumber: regex }] });
  }
  const startedAt: Record<string, Date> = {};
  if (typeof request.query.from === "string" && request.query.from) {
    startedAt.$gte = new Date(request.query.from);
  }
  if (typeof request.query.to === "string" && request.query.to) {
    startedAt.$lte = new Date(request.query.to);
  }
  if (Object.keys(startedAt).length) filters.startedAt = startedAt;
  if (andFilters.length) filters.$and = andFilters;
  return filters;
}

function callStreamAgentId(request: AuthenticatedRequest) {
  const agentId = typeof request.query.agentId === "string" ? request.query.agentId.trim() : "";
  if (agentId && !isValidObjectId(agentId)) throw new HttpError(400, "Valid agentId is required.");
  return agentId;
}

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type CallLike = {
  id?: string;
  _id?: unknown;
  costBreakdown?: {
    pricingStatus?: "exact" | "estimated" | "unpriced";
    llm?: number;
    stt?: number;
    tts?: number;
    telephony?: number;
    providerCost?: number;
    platformFee?: number;
    customerCost?: number;
    total?: number;
    currency?: string;
  } | null;
  toObject?: () => Record<string, unknown>;
};

type CostBreakdownLike = NonNullable<CallLike["costBreakdown"]> & {
  calculationVersion?: string;
  pricing?: unknown;
};

type PhoneNumberSource = "recorded" | "room_name" | "missing";

function providerValue(value: unknown, fallback: unknown) {
  const current = typeof value === "string" ? value.trim() : "";
  if (current && current.toLowerCase() !== "unknown") return current;
  const next = typeof fallback === "string" ? fallback.trim() : "";
  return next && next.toLowerCase() !== "unknown" ? next : "";
}

function agentLanguageValue(agent: Record<string, unknown>) {
  return effectiveCallLanguage({
    language: providerValue(agent.language, ""),
    multilingualEnabled: agent.multilingualEnabled === true,
  });
}

function callId(call: CallLike) {
  return call.id ?? String(call._id ?? "");
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
  const text = textValue(value);
  const e164 = text.match(/\+\d[\d\s().-]{5,}\d/);
  if (e164) return `+${e164[0].replace(/\D/g, "")}`;
  const local = text.match(/(?:^|\D)(\d{7,15})(?=\D|$)/)?.[1] ?? "";
  return local ? normalizePhoneDigits(local, countryContext) : "";
}

function idValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isoValue(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
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

function inboundRoomNumbers(value: unknown) {
  const roomName = textValue(value);
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

function inboundNumberFromRoom(value: unknown) {
  return inboundRoomNumbers(value).calledNumber;
}

function inboundCallerNumberFromRoom(value: unknown) {
  return inboundRoomNumbers(value).callerNumber;
}

function routeNumberDetails(raw: Record<string, unknown>) {
  const inferredCaller = raw.direction === "inbound" ? inboundCallerNumberFromRoom(raw.livekitRoomName) : "";
  const inferredCalled = raw.direction === "inbound" ? inboundNumberFromRoom(raw.livekitRoomName) : "";
  const rawRecordedCalled = textValue(raw.calledNumber);
  const rawRecordedCaller = textValue(raw.callerNumber);
  const recordedCalled = phoneValue(rawRecordedCalled, inferredCalled);
  const calledNumber = recordedCalled || inferredCalled;
  const recordedCaller = phoneValue(rawRecordedCaller, calledNumber);
  const callerNumber = recordedCaller || inferredCaller;
  return {
    callerNumber,
    calledNumber,
    callerNumberSource: (rawRecordedCaller ? "recorded" : inferredCaller ? "room_name" : "missing") as PhoneNumberSource,
    calledNumberSource: (rawRecordedCalled ? "recorded" : inferredCalled ? "room_name" : "missing") as PhoneNumberSource,
  };
}

function usageRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function hasReportedSttUsage(modelUsage: Record<string, unknown>[]) {
  return modelUsage.some((item) => item.type === "stt_usage" && numberValue(item.audioDurationMs) > 0);
}

function isRealtimeAudioStack(provider: string, model: string, modelUsage: Record<string, unknown>[]) {
  const stack = `${provider}:${model}`.toLowerCase();
  return (
    stack.includes("realtime") ||
    stack.includes("live") ||
    modelUsage.some((item) =>
      item.type === "llm_usage" &&
      (numberValue(item.inputAudioTokens) > 0 || numberValue(item.outputAudioTokens) > 0),
    )
  );
}

function normalizeRealtimeModel(provider: string, model: string) {
  if (provider === "gemini") return normalizeGeminiRealtimeModel(model);
  if (provider === "openai") return normalizeOpenAIRealtimeModel(model);
  return model;
}

function effectiveCallStack(raw: Record<string, unknown>, agent: Record<string, unknown>, modelUsage: Record<string, unknown>[]) {
  let llmProvider = canonicalPricingProvider(providerValue(raw.llmProvider, agent.llmProvider));
  let llmModel = providerValue(raw.llmModel, agent.llmModel);
  let sttProvider = canonicalPricingProvider(providerValue(raw.sttProvider, agent.sttProvider));
  let sttModel = providerValue(raw.sttModel, agent.sttModel);
  let ttsProvider = canonicalPricingProvider(providerValue(raw.ttsProvider, agent.ttsProvider));
  let ttsModel = providerValue(raw.ttsModel, agent.ttsModel);
  const explicitRealtimeProvider = canonicalPricingProvider(providerValue(raw.realtimeProvider, agent.realtimeProvider));
  const explicitRealtimeModel = normalizeRealtimeModel(
    explicitRealtimeProvider,
    providerValue(raw.realtimeModel, agent.realtimeModel),
  );
  const hasAudioUsage = isRealtimeAudioStack(llmProvider, llmModel, modelUsage);
  const configuredRealtime = raw.pipelineMode === "realtime" || /(realtime|live|native-audio)/i.test(llmModel);

  if (configuredRealtime || hasAudioUsage) {
    llmProvider = explicitRealtimeProvider || llmProvider;
    llmModel = explicitRealtimeModel || llmModel;
    if (!/(realtime|live|native-audio)/i.test(llmModel) && hasAudioUsage) {
      llmModel = llmProvider === "gemini"
        ? defaultGeminiRealtimeModel
        : llmProvider === "openai"
          ? defaultOpenAIRealtimeModel
          : llmModel;
    }
    sttProvider = "";
    sttModel = "";
    ttsProvider = "";
    ttsModel = "";
  }

  return {
    pipelineMode: configuredRealtime || hasAudioUsage ? "realtime" : "pipeline",
    llmProvider,
    llmModel,
    sttProvider,
    sttModel,
    ttsProvider,
    ttsModel,
    ttsVoice: providerValue(raw.ttsVoice, agent.voice),
  };
}

function displayedCostBreakdown(
  raw: Record<string, unknown>,
  agent: Record<string, unknown>,
  current: CostBreakdownLike,
  freezeSettledPricing = false,
) {
  const modelUsage = usageRecords(raw.modelUsage);
  const stack = effectiveCallStack(raw, agent, modelUsage);
  const durationSeconds = numberValue(raw.durationSeconds);
  const sttSeconds = numberValue(raw.sttSeconds);
  const shouldEstimateStt =
    ["completed", "failed"].includes(String(raw.status)) &&
    sttSeconds <= 0 &&
    durationSeconds > 0 &&
    Boolean(stack.sttProvider && stack.sttModel) &&
    !hasReportedSttUsage(modelUsage) &&
    stack.pipelineMode !== "realtime";

  if (freezeSettledPricing || (current.calculationVersion === MODEL_PRICING_VERSION && !shouldEstimateStt)) {
    return { cost: current, estimatedSttSeconds: 0, stack };
  }

  const effectiveModelUsage = shouldEstimateStt
    ? [...modelUsage, {
        type: "stt_usage",
        provider: stack.sttProvider,
        model: stack.sttModel,
        audioDurationMs: Math.round(durationSeconds * 1000),
        estimated: true,
        note: "Estimated from call duration because provider did not report STT audio usage.",
      }]
    : modelUsage;

  return {
    cost: calculateCallCost({
      llmProvider: stack.llmProvider,
      llmModel: stack.llmModel,
      llmInputTokens: numberValue(raw.llmInputTokens),
      llmOutputTokens: numberValue(raw.llmOutputTokens),
      llmTokens: numberValue(raw.llmTokens),
      sttProvider: stack.sttProvider,
      sttModel: stack.sttModel,
      sttLanguage: providerValue(raw.language, agentLanguageValue(agent)),
      sttSeconds: shouldEstimateStt ? durationSeconds : sttSeconds,
      sttInputTokens: numberValue(raw.sttInputTokens),
      sttOutputTokens: numberValue(raw.sttOutputTokens),
      ttsProvider: stack.ttsProvider,
      ttsModel: stack.ttsModel,
      ttsVoice: stack.ttsVoice,
      ttsCharacters: numberValue(raw.ttsCharacters),
      ttsAudioSeconds: numberValue(raw.ttsAudioSeconds),
      ttsInputTokens: numberValue(raw.ttsInputTokens),
      ttsOutputTokens: numberValue(raw.ttsOutputTokens),
      durationSeconds,
      modelUsage: effectiveModelUsage,
      isRealtime: stack.pipelineMode === "realtime",
    }),
    estimatedSttSeconds: shouldEstimateStt ? durationSeconds : 0,
    stack,
  };
}

function brandedCostBreakdown<T extends CostBreakdownLike>(cost: T, whiteLabel: boolean): T {
  if (!whiteLabel || !cost.pricing || typeof cost.pricing !== "object") return cost;
  const pricing = cost.pricing as Record<string, unknown>;
  const platformFee = pricing.platformFee && typeof pricing.platformFee === "object"
    ? pricing.platformFee as Record<string, unknown>
    : null;
  if (!platformFee || typeof platformFee.note !== "string") return cost;
  return {
    ...cost,
    pricing: {
      ...pricing,
      platformFee: {
        ...platformFee,
        note: platformFee.note.replace(/^Vozon platform fee/i, "Platform fee"),
      },
    },
  };
}

async function attachBillingDetails<T extends CallLike>(calls: T[], whiteLabel = false) {
  const ids = calls.map(callId);
  const transactions = await BillingTransactionModel.find({
    callId: { $in: ids },
    category: "call",
    type: { $in: ["deduction", "refund"] },
  }).sort({ createdAt: -1 }).lean();
  const byCall = new Map<string, typeof transactions>();
  for (const transaction of transactions) {
    const group = byCall.get(transaction.callId) ?? [];
    group.push(transaction);
    byCall.set(transaction.callId, group);
  }

  return calls.map((call) => {
    const raw: Record<string, unknown> = call.toObject
      ? call.toObject()
      : { ...(call as unknown as Record<string, unknown>) };
    const id = callId(call);
    const callTransactions = byCall.get(id) ?? [];
    const agent = raw.agentId && typeof raw.agentId === "object"
      ? raw.agentId as Record<string, unknown>
      : {};
    const displayCost = displayedCostBreakdown(
      raw,
      agent,
      (call.costBreakdown ?? {}) as CostBreakdownLike,
      callTransactions.length > 0,
    );
    const cost = brandedCostBreakdown(displayCost.cost, whiteLabel);
    const chargedCredits = rounded(Math.max(
      0,
      -callTransactions.reduce((sum, transaction) => sum + transaction.amountCredits, 0),
    ));
    const providerCost = rounded(
      cost.providerCost ??
        ((cost.llm ?? 0) + (cost.stt ?? 0) + (cost.tts ?? 0)),
    );
    const platformFee = rounded(cost.platformFee ?? 0);
    const customerCost = rounded(cost.customerCost ?? cost.total ?? (providerCost + platformFee));
    const estimatedCharge = callTransactions.length > 0
      ? chargedCredits
      : cost.pricingStatus === "unpriced"
        ? 0
        : customerCost;
    const routeNumbers = routeNumberDetails(raw);

    return {
      ...raw,
      ...routeNumbers,
      sttSeconds: displayCost.estimatedSttSeconds > 0 ? displayCost.estimatedSttSeconds : raw.sttSeconds,
      costBreakdown: cost,
      pipelineMode: displayCost.stack.pipelineMode,
      llmProvider: displayCost.stack.llmProvider,
      llmModel: displayCost.stack.llmModel,
      sttProvider: displayCost.stack.sttProvider,
      sttModel: displayCost.stack.sttModel,
      ttsProvider: displayCost.stack.ttsProvider,
      ttsModel: displayCost.stack.ttsModel,
      ttsVoice: displayCost.stack.ttsVoice,
      billing: {
        chargedCredits,
        estimatedChargeCredits: estimatedCharge,
        providerCost,
        platformFee,
        customerCost,
        currency: cost.currency ?? creditBillingSettings.currency,
        balanceAfterCredits: callTransactions[0]?.balanceAfterCredits ?? null,
        breakdown: {
          llm: rounded(cost.llm ?? 0),
          stt: rounded(cost.stt ?? 0),
          tts: rounded(cost.tts ?? 0),
          telephony: 0,
          platformFee,
          providerCost,
          customerCost,
          total: customerCost,
          chargedLlm: rounded(cost.llm ?? 0),
          chargedStt: rounded(cost.stt ?? 0),
          chargedTts: rounded(cost.tts ?? 0),
          chargedTelephony: 0,
          chargedPlatformFee: platformFee,
        },
        transactions: callTransactions,
      },
    };
  });
}

function externalTranscript(raw: Record<string, unknown>) {
  const transcript = Array.isArray(raw.transcript)
    ? raw.transcript.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

  return dedupeLegacyUserTranscriptItems(transcript.map((item) => {
    const role = textValue(item.role) || "system";
    const text = textValue(item.text);
    return {
      itemId: textValue(item.itemId),
      role,
      content: text,
      text,
      timestamp: isoValue(item.timestamp),
      interrupted: Boolean(item.interrupted),
    };
  }));
}

function externalTranscriptText(chat: ReturnType<typeof externalTranscript>) {
  return chat
    .map((item) => {
      const speaker = item.role === "user" ? "Customer" : item.role === "assistant" ? "Agent" : item.role;
      return `${speaker}: ${item.text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function signedRecordingUrl(request: AuthenticatedRequest, callIdValue: string, recordingKey: string) {
  if (!recordingKey) return "";
  const expires = recordingAccessExpires();
  const signature = signRecordingAccess(callIdValue, expires);
  const query = new URLSearchParams({ expires: String(expires), signature });
  return absoluteApiUrl(
    request,
    `/api/public/recordings/${encodeURIComponent(callIdValue)}?${query.toString()}`,
  );
}

function externalCallPayload(request: AuthenticatedRequest, raw: Record<string, unknown>) {
  const id = idValue(raw._id || raw.id);
  const agent = objectValue(raw.agentId);
  const agentId = idValue(agent._id || raw.agentId);
  const route = routeNumberDetails(raw);
  const direction = textValue(raw.direction);
  const status = textValue(raw.status);
  const startedAt = isoValue(raw.startedAt || raw.createdAt);
  const endedAt = isoValue(raw.endedAt);
  const createdAt = isoValue(raw.createdAt);
  const updatedAt = isoValue(raw.updatedAt);
  const recordingKey = textValue(raw.recordingKey);
  const existingRecordingUrl = textValue(raw.recordingUrl);
  const publicRecordingUrl = recordingPublicUrl(recordingKey);
  const stableRecordingUrl = signedRecordingUrl(request, id, recordingKey);
  const recordingUrl = publicRecordingUrl || stableRecordingUrl || existingRecordingUrl;
  const chat = externalTranscript(raw);
  const transcription = externalTranscriptText(chat);
  const durationSeconds = numberValue(raw.durationSeconds);
  const recordingDuration = numberValue(raw.recordingDuration);
  const costBreakdown = objectValue(raw.costBreakdown);
  const billing = objectValue(raw.billing);
  const structuredOutput = objectValue(raw.structuredOutput);

  return {
    id,
    _id: id,
    callId: id,
    call_id: id,
    session_id: textValue(raw.livekitRoomName) || id,
    livekitRoomName: textValue(raw.livekitRoomName),
    livekitDispatchId: textValue(raw.livekitDispatchId),
    livekitParticipantId: textValue(raw.livekitParticipantId),
    agentId,
    agent_id: agentId,
    agentName: textValue(agent.name),
    agent_name: textValue(agent.name),
    agent: {
      id: agentId,
      name: textValue(agent.name),
      team: textValue(agent.team),
    },
    direction,
    status,
    call_status: status,
    callerNumber: route.callerNumber,
    calledNumber: route.calledNumber,
    callerNumberSource: route.callerNumberSource,
    calledNumberSource: route.calledNumberSource,
    from_number: route.callerNumber,
    to_number: route.calledNumber,
    voip: {
      from: route.callerNumber,
      to: route.calledNumber,
      direction,
    },
    startedAt,
    endedAt,
    createdAt,
    updatedAt,
    start_time: startedAt,
    end_time: endedAt,
    ts: startedAt ? Math.floor(new Date(startedAt).getTime() / 1000) : null,
    durationSeconds,
    duration: durationSeconds,
    transcript: chat,
    chat,
    messages: chat,
    transcription: chat,
    transcription_text: transcription,
    transcript_text: transcription,
    recordingKey,
    recordingUrl,
    recording_url: recordingUrl,
    recording: {
      key: recordingKey,
      url: recordingUrl,
      downloadUrl: recordingUrl,
      status: textValue(raw.recordingStatus),
      egressId: textValue(raw.recordingEgressId),
      durationSeconds: recordingDuration,
      duration: recordingDuration,
      error: textValue(raw.recordingError),
      contentType: recordingKey ? recordingMimeType(recordingKey) : "",
    },
    providers: {
      llm: {
        provider: textValue(raw.llmProvider),
        model: textValue(raw.llmModel),
        inputTokens: numberValue(raw.llmInputTokens),
        outputTokens: numberValue(raw.llmOutputTokens),
        totalTokens: numberValue(raw.llmTokens),
      },
      stt: {
        provider: textValue(raw.sttProvider),
        model: textValue(raw.sttModel),
        inputTokens: numberValue(raw.sttInputTokens),
        outputTokens: numberValue(raw.sttOutputTokens),
        seconds: numberValue(raw.sttSeconds),
      },
      tts: {
        provider: textValue(raw.ttsProvider),
        model: textValue(raw.ttsModel),
        voice: textValue(raw.ttsVoice),
        inputTokens: numberValue(raw.ttsInputTokens),
        outputTokens: numberValue(raw.ttsOutputTokens),
        audioSeconds: numberValue(raw.ttsAudioSeconds),
        characters: numberValue(raw.ttsCharacters),
      },
    },
    usage: {
      llmInputTokens: numberValue(raw.llmInputTokens),
      llmOutputTokens: numberValue(raw.llmOutputTokens),
      llmTokens: numberValue(raw.llmTokens),
      sttInputTokens: numberValue(raw.sttInputTokens),
      sttOutputTokens: numberValue(raw.sttOutputTokens),
      sttSeconds: numberValue(raw.sttSeconds),
      ttsInputTokens: numberValue(raw.ttsInputTokens),
      ttsOutputTokens: numberValue(raw.ttsOutputTokens),
      ttsAudioSeconds: numberValue(raw.ttsAudioSeconds),
      ttsCharacters: numberValue(raw.ttsCharacters),
      modelUsage: Array.isArray(raw.modelUsage) ? raw.modelUsage : [],
      avgResponseLatencyMs: numberValue(raw.avgResponseLatencyMs),
      responseLatencyP50Ms: numberValue(raw.responseLatencyP50Ms),
      responseLatencyP90Ms: numberValue(raw.responseLatencyP90Ms),
      responseLatencyP95Ms: numberValue(raw.responseLatencyP95Ms),
      responseLatencyP99Ms: numberValue(raw.responseLatencyP99Ms),
    },
    costBreakdown,
    cost: costBreakdown,
    billing,
    sentiment: {
      score: typeof raw.sentimentScore === "number" ? raw.sentimentScore : null,
      label: textValue(raw.sentimentLabel),
    },
    endReason: textValue(raw.endReason),
    errorMessage: textValue(raw.errorMessage),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
    structuredOutput,
    structuredOutputStatus: textValue(raw.structuredOutputStatus),
    structuredOutputError: textValue(raw.structuredOutputError),
    voicemailDetected: Boolean(raw.voicemailDetected),
    metadata: {
      source: "ai_voice_platform",
      apiVersion: "v1",
      hasTranscript: chat.length > 0,
      hasRecording: Boolean(recordingKey || recordingUrl),
    },
  };
}

function externalCallsPayload(request: AuthenticatedRequest, calls: Record<string, unknown>[]) {
  return calls.map((call) => externalCallPayload(request, call));
}

export async function listCalls(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
  const filters = callFilters(request);
  if (request.query.view === "recent") {
    const calls = await CallDetailRecordModel.find(filters)
      .select("_id callerNumber calledNumber status durationSeconds")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    response.json({
      calls,
      pagination: { page: 1, limit, total: calls.length, pages: 1 },
    });
    return;
  }
  const [callDocs, total] = await Promise.all([
    CallDetailRecordModel.find(filters)
      .populate("agentId", "name team pipelineMode realtimeProvider realtimeModel llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice language multilingualEnabled languageSwitchingEnabled supportedLanguages")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CallDetailRecordModel.countDocuments(filters),
  ]);
  const calls = await attachBillingDetails(callDocs, Boolean(request.whiteLabel));
  response.json({ calls, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}

export async function listExternalCalls(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
  const filters = callFilters(request);
  const [callDocs, total] = await Promise.all([
    CallDetailRecordModel.find(filters)
      .populate("agentId", "name team pipelineMode realtimeProvider realtimeModel llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice language multilingualEnabled languageSwitchingEnabled supportedLanguages")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CallDetailRecordModel.countDocuments(filters),
  ]);
  const withBilling = await attachBillingDetails(callDocs, Boolean(request.whiteLabel));
  const calls = externalCallsPayload(request, withBilling);
  response.json({
    calls,
    histories: calls,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function streamCallEvents(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agentId = callStreamAgentId(request);
  const fullDocumentMatch: Record<string, unknown> = { "fullDocument.ownerId": userId };
  if (agentId) fullDocumentMatch["fullDocument.agentId"] = new Types.ObjectId(agentId);

  response.status(200);
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write("retry: 2000\n\n");

  let closed = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  const callChanges = CallDetailRecordModel.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace"] },
          ...fullDocumentMatch,
        },
      },
    ],
    { fullDocument: "updateLookup" },
  );

  const emitChanged = () => {
    if (closed) return;
    response.write(`event: calls_changed\nid: ${Date.now()}\ndata: ${JSON.stringify({ changedAt: new Date().toISOString() })}\n\n`);
  };

  const scheduleChanged = () => {
    if (closed || emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      emitChanged();
    }, 100);
  };

  callChanges.on("change", scheduleChanged);

  const heartbeat = setInterval(() => {
    if (!closed) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 30000);
  heartbeat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    if (emitTimer) clearTimeout(emitTimer);
    clearInterval(heartbeat);
    void callChanges.close().catch(() => undefined);
  };

  callChanges.on("error", (error) => {
    if (!closed) {
      response.write(`event: calls_error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      response.end();
    }
    close();
  });
  request.on("close", close);

  response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
}

export async function getCall(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).populate("agentId", "name team pipelineMode realtimeProvider realtimeModel llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice language multilingualEnabled languageSwitchingEnabled supportedLanguages");
  if (!call) throw new HttpError(404, "Call record not found.");
  const [withBilling] = await attachBillingDetails([call], Boolean(request.whiteLabel));
  response.json({ call: withBilling });
}

export async function getExternalCall(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).populate("agentId", "name team pipelineMode realtimeProvider realtimeModel llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice language multilingualEnabled languageSwitchingEnabled supportedLanguages");
  if (!call) throw new HttpError(404, "Call record not found.");
  const [withBilling] = await attachBillingDetails([call], Boolean(request.whiteLabel));
  const payload = externalCallPayload(request, withBilling);
  response.json({ call: payload, history: payload });
}

export async function getCallInvoice(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).populate("agentId", "name team");
  if (!call) throw new HttpError(404, "Call record not found.");

  const transactions = await BillingTransactionModel.find({
    orgId: call.ownerId,
    callId: call.id,
    type: "deduction",
  }).sort({ createdAt: -1 });
  const totalCreditsDeducted = rounded(
    transactions.reduce((sum, transaction) => sum + Math.abs(transaction.amountCredits), 0),
  );
  const lineItems = [
    { label: "Speech to text", quantity: `${Math.round(call.sttSeconds)} sec`, credits: rounded(call.costBreakdown?.stt ?? 0) },
    { label: "Language model", quantity: `${call.llmTokens.toLocaleString("en-US")} tokens`, credits: rounded(call.costBreakdown?.llm ?? 0) },
    { label: "Text to speech", quantity: `${call.ttsCharacters.toLocaleString("en-US")} chars`, credits: rounded(call.costBreakdown?.tts ?? 0) },
  ];

  response.json({
    invoice: {
      callId: call.id,
      date: call.startedAt ?? call.createdAt,
      durationMinutes: rounded(call.durationSeconds / 60),
      currency: creditBillingSettings.currency,
      lineItems,
      totalCreditsDeducted,
      balanceAfterCredits: transactions[0]?.balanceAfterCredits ?? null,
      transactions,
    },
  });
}

export async function uploadWebCallRecording(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
    direction: "web",
  });
  if (!call) throw new HttpError(404, "Web call record not found.");

  const body = Buffer.isBuffer(request.body) ? request.body : null;
  if (!body?.length) throw new HttpError(400, "Recording upload is empty.");

  const contentType = normalizedContentType(request.headers["content-type"]);
  const extension = recordingExtension(contentType);
  if (!recordingS3Configured()) throw new HttpError(503, recordingS3ConfigError());
  const recordingKey = webRecordingKey(call.id, extension);
  await uploadRecordingObject(recordingKey, body, contentType);

  call.recordingKey = recordingKey;
  call.recordingUrl = recordingPublicUrl(recordingKey) || absoluteApiUrl(request, `/api/voice/calls/${call.id}/recording-file`);
  call.recordingStatus = "completed";
  call.recordingError = "";
  call.recordingDuration = durationSecondsFromHeader(request.headers["x-recording-duration-ms"]) || call.durationSeconds;
  await call.save();

  const [withBilling] = await attachBillingDetails([call], Boolean(request.whiteLabel));
  response.status(201).json({ call: withBilling });
}

async function streamRecordingFile(request: Request, response: Response, recordingKey: string) {
  const contentType = recordingMimeType(recordingKey);
  if (recordingS3Configured()) {
    const objectResponse = await getRecordingObject(recordingKey, typeof request.headers.range === "string" ? request.headers.range : "");
    if (objectResponse.status === 404) throw new HttpError(404, "Recording file not found.");
    if (objectResponse.status === 416) {
      const contentRange = objectResponse.headers.get("content-range");
      if (contentRange) response.setHeader("Content-Range", contentRange);
      response.status(416).end();
      return;
    }
    if (!objectResponse.ok || !objectResponse.body) {
      throw new HttpError(502, `Could not load recording from S3. Storage returned HTTP ${objectResponse.status}.`);
    }

    const headers: Record<string, string> = {
      "Accept-Ranges": objectResponse.headers.get("accept-ranges") || "bytes",
      "Content-Disposition": `inline; filename="${path.basename(recordingKey)}"`,
      "Content-Type": objectResponse.headers.get("content-type") || contentType,
    };
    const contentLength = objectResponse.headers.get("content-length");
    const contentRange = objectResponse.headers.get("content-range");
    if (contentLength) headers["Content-Length"] = contentLength;
    if (contentRange) headers["Content-Range"] = contentRange;

    response.status(objectResponse.status === 206 ? 206 : 200).set(headers);
    Readable.fromWeb(objectResponse.body as unknown as NodeReadableStream<Uint8Array>).pipe(response);
    return;
  }

  const filePath = resolveRecordingPath(recordingKey);
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    throw new HttpError(404, "Recording file not found.");
  }
  if (!stats.isFile()) throw new HttpError(404, "Recording file not found.");

  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.status(416).setHeader("Content-Range", `bytes */${stats.size}`).end();
      return;
    }

    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : stats.size - 1;
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);
      start = Math.max(stats.size - suffixLength, 0);
      end = stats.size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stats.size) {
      response.status(416).setHeader("Content-Range", `bytes */${stats.size}`).end();
      return;
    }
    end = Math.min(end, stats.size - 1);

    response
      .status(206)
      .set({
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Content-Type": contentType,
      });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response
    .status(200)
    .set({
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${path.basename(filePath)}"`,
      "Content-Length": String(stats.size),
      "Content-Type": contentType,
    });
  createReadStream(filePath).pipe(response);
}

export async function streamCallRecordingFile(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).select("recordingKey");
  if (!call?.recordingKey) throw new HttpError(404, "Recording file not found.");

  await streamRecordingFile(request, response, call.recordingKey);
}

export async function streamSignedCallRecordingFile(request: Request, response: Response) {
  const callId = String(request.params.callId ?? "");
  if (!verifyRecordingAccess(callId, request.query.expires, request.query.signature)) {
    throw new HttpError(401, "Recording link is invalid or has expired.");
  }

  const call = await CallDetailRecordModel.findById(callId).select("recordingKey");
  if (!call?.recordingKey) throw new HttpError(404, "Recording file not found.");

  await streamRecordingFile(request, response, call.recordingKey);
}

export async function exportCallsCsv(request: AuthenticatedRequest, response: Response) {
  const calls = await CallDetailRecordModel.find(callFilters(request))
    .populate("agentId", "name")
    .sort({ createdAt: -1 })
    .limit(10000);
  const rows = [
    [
      "Call ID",
      "Agent",
      "Direction",
      "Status",
      "Caller",
      "Caller source",
      "Called",
      "Called source",
      "Started",
      "Duration (seconds)",
      "Latency (ms)",
      "Sentiment",
      "Provider cost (USD)",
      request.whiteLabel ? "Platform fee (USD)" : "Vozon platform fee (USD)",
      "Customer total (USD)",
      "LLM cost",
      "STT cost",
      "TTS cost",
      "Tags",
      "End reason",
    ],
    ...calls.map((call) => {
      const routeNumbers = routeNumberDetails(call.toObject());
      return [
        call.id,
        (call.agentId as unknown as { name?: string })?.name ?? "",
        call.direction,
        call.status,
        routeNumbers.callerNumber,
        routeNumbers.callerNumberSource,
        routeNumbers.calledNumber,
        routeNumbers.calledNumberSource,
        call.startedAt?.toISOString() ?? "",
        call.durationSeconds,
        call.avgResponseLatencyMs,
        call.sentimentLabel,
        call.costBreakdown?.providerCost ?? 0,
        call.costBreakdown?.platformFee ?? 0,
        call.costBreakdown?.customerCost ?? call.costBreakdown?.total ?? 0,
        call.costBreakdown?.llm ?? 0,
        call.costBreakdown?.stt ?? 0,
        call.costBreakdown?.tts ?? 0,
        call.tags.join("|"),
        call.endReason,
      ];
    }),
  ];
  response
    .status(200)
    .type("text/csv")
    .setHeader("Content-Disposition", `attachment; filename="calls-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(rows.map((row) => row.map(escapeCsv).join(",")).join("\n"));
}
