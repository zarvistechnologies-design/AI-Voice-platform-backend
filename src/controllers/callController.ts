import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { creditBillingSettings } from "../services/billingService.js";
import { calculateCallCost } from "../services/modelPricingService.js";
import { HttpError } from "../utils/httpError.js";

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

function absoluteApiUrl(request: AuthenticatedRequest, pathname: string) {
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

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type CallLike = {
  id?: string;
  _id?: unknown;
  costBreakdown?: {
    llm?: number;
    stt?: number;
    tts?: number;
    telephony?: number;
    total?: number;
    currency?: string;
  } | null;
  toObject?: () => Record<string, unknown>;
};

type CostBreakdownLike = NonNullable<CallLike["costBreakdown"]> & {
  pricing?: unknown;
};

function providerValue(value: unknown, fallback: unknown) {
  const current = typeof value === "string" ? value.trim() : "";
  if (current && current.toLowerCase() !== "unknown") return current;
  const next = typeof fallback === "string" ? fallback.trim() : "";
  return next && next.toLowerCase() !== "unknown" ? next : "";
}

function callId(call: CallLike) {
  return call.id ?? String(call._id ?? "");
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
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

function displayedCostBreakdown(raw: Record<string, unknown>, agent: Record<string, unknown>, current: CostBreakdownLike) {
  const modelUsage = usageRecords(raw.modelUsage);
  const llmProvider = providerValue(raw.llmProvider, agent.llmProvider);
  const llmModel = providerValue(raw.llmModel, agent.llmModel);
  const sttProvider = providerValue(raw.sttProvider, agent.sttProvider);
  const sttModel = providerValue(raw.sttModel, agent.sttModel);
  const ttsProvider = providerValue(raw.ttsProvider, agent.ttsProvider);
  const ttsModel = providerValue(raw.ttsModel, agent.ttsModel);
  const ttsVoice = providerValue(raw.ttsVoice, agent.voice);
  const durationSeconds = numberValue(raw.durationSeconds);
  const sttSeconds = numberValue(raw.sttSeconds);
  const shouldEstimateStt =
    ["completed", "failed"].includes(String(raw.status)) &&
    sttSeconds <= 0 &&
    durationSeconds > 0 &&
    Boolean(sttProvider && sttModel) &&
    !hasReportedSttUsage(modelUsage) &&
    !isRealtimeAudioStack(llmProvider, llmModel, modelUsage);

  if (!shouldEstimateStt) return { cost: current, estimatedSttSeconds: 0 };

  const estimatedSttUsage = {
    type: "stt_usage",
    provider: sttProvider,
    model: sttModel,
    audioDurationMs: Math.round(durationSeconds * 1000),
    estimated: true,
    note: "Estimated from call duration because provider did not report STT audio usage.",
  };

  return {
    cost: calculateCallCost({
      llmProvider,
      llmModel,
      llmInputTokens: numberValue(raw.llmInputTokens),
      llmOutputTokens: numberValue(raw.llmOutputTokens),
      llmTokens: numberValue(raw.llmTokens),
      sttProvider,
      sttModel,
      sttSeconds: durationSeconds,
      sttInputTokens: numberValue(raw.sttInputTokens),
      sttOutputTokens: numberValue(raw.sttOutputTokens),
      ttsProvider,
      ttsModel,
      ttsVoice,
      ttsCharacters: numberValue(raw.ttsCharacters),
      ttsAudioSeconds: numberValue(raw.ttsAudioSeconds),
      ttsInputTokens: numberValue(raw.ttsInputTokens),
      ttsOutputTokens: numberValue(raw.ttsOutputTokens),
      durationSeconds,
      modelUsage: [...modelUsage, estimatedSttUsage],
    }),
    estimatedSttSeconds: durationSeconds,
  };
}

async function attachBillingDetails<T extends CallLike>(calls: T[]) {
  const ids = calls.map(callId);
  const transactions = await BillingTransactionModel.find({
    callId: { $in: ids },
    type: "deduction",
  }).lean();
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
    const displayCost = displayedCostBreakdown(raw, agent, (call.costBreakdown ?? {}) as CostBreakdownLike);
    const cost = displayCost.cost;
    const chargedCredits = rounded(
      callTransactions.reduce((sum, transaction) => sum + Math.abs(transaction.amountCredits), 0),
    );
    const estimatedCharge = rounded((cost.total ?? 0) * creditBillingSettings.markupMultiplier);

    return {
      ...raw,
      sttSeconds: displayCost.estimatedSttSeconds > 0 ? displayCost.estimatedSttSeconds : raw.sttSeconds,
      costBreakdown: cost,
      llmProvider: providerValue(raw.llmProvider, agent.llmProvider),
      llmModel: providerValue(raw.llmModel, agent.llmModel),
      sttProvider: providerValue(raw.sttProvider, agent.sttProvider),
      sttModel: providerValue(raw.sttModel, agent.sttModel),
      ttsProvider: providerValue(raw.ttsProvider, agent.ttsProvider),
      ttsModel: providerValue(raw.ttsModel, agent.ttsModel),
      ttsVoice: providerValue(raw.ttsVoice, agent.voice),
      billing: {
        chargedCredits,
        estimatedChargeCredits: estimatedCharge,
        providerCost: rounded(cost.total ?? 0),
        currency: cost.currency ?? creditBillingSettings.currency,
        balanceAfterCredits: callTransactions[0]?.balanceAfterCredits ?? null,
        breakdown: {
          llm: rounded(cost.llm ?? 0),
          stt: rounded(cost.stt ?? 0),
          tts: rounded(cost.tts ?? 0),
          telephony: rounded(cost.telephony ?? 0),
          total: rounded(cost.total ?? 0),
          chargedLlm: rounded((cost.llm ?? 0) * creditBillingSettings.markupMultiplier),
          chargedStt: rounded((cost.stt ?? 0) * creditBillingSettings.markupMultiplier),
          chargedTts: rounded((cost.tts ?? 0) * creditBillingSettings.markupMultiplier),
          chargedTelephony: rounded((cost.telephony ?? 0) * creditBillingSettings.markupMultiplier),
        },
        transactions: callTransactions,
      },
    };
  });
}

export async function listCalls(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
  const filters = callFilters(request);
  const [callDocs, total] = await Promise.all([
    CallDetailRecordModel.find(filters)
      .populate("agentId", "name team llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CallDetailRecordModel.countDocuments(filters),
  ]);
  const calls = await attachBillingDetails(callDocs);
  response.json({ calls, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}

export async function getCall(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).populate("agentId", "name team llmProvider llmModel sttProvider sttModel ttsProvider ttsModel voice");
  if (!call) throw new HttpError(404, "Call record not found.");
  const [withBilling] = await attachBillingDetails([call]);
  response.json({ call: withBilling });
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
  const multiplier = creditBillingSettings.markupMultiplier;
  const lineItems = [
    { label: "Speech to text", quantity: `${Math.round(call.sttSeconds)} sec`, credits: rounded((call.costBreakdown?.stt ?? 0) * multiplier) },
    { label: "Language model", quantity: `${call.llmTokens.toLocaleString("en-US")} tokens`, credits: rounded((call.costBreakdown?.llm ?? 0) * multiplier) },
    { label: "Text to speech", quantity: `${call.ttsCharacters.toLocaleString("en-US")} chars`, credits: rounded((call.costBreakdown?.tts ?? 0) * multiplier) },
    { label: "Carrier", quantity: `${Math.ceil(call.durationSeconds / 60)} min`, credits: rounded((call.costBreakdown?.telephony ?? 0) * multiplier) },
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
  const safeCallId = call.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const recordingKey = `web/${safeCallId}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  const filePath = resolveRecordingPath(recordingKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);

  call.recordingKey = recordingKey;
  call.recordingUrl = absoluteApiUrl(request, `/api/voice/calls/${call.id}/recording-file`);
  call.recordingStatus = "completed";
  call.recordingError = "";
  call.recordingDuration = durationSecondsFromHeader(request.headers["x-recording-duration-ms"]) || call.durationSeconds;
  await call.save();

  const [withBilling] = await attachBillingDetails([call]);
  response.status(201).json({ call: withBilling });
}

export async function streamCallRecordingFile(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).select("recordingKey");
  if (!call?.recordingKey) throw new HttpError(404, "Recording file not found.");

  const filePath = resolveRecordingPath(call.recordingKey);
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    throw new HttpError(404, "Recording file not found.");
  }
  if (!stats.isFile()) throw new HttpError(404, "Recording file not found.");

  const contentType = recordingMimeType(call.recordingKey);
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
      "Called",
      "Started",
      "Duration (seconds)",
      "Latency (ms)",
      "Sentiment",
      "Provider cost (USD)",
      "Charged credits",
      "LLM cost",
      "STT cost",
      "TTS cost",
      "Telephony cost",
      "Tags",
      "End reason",
    ],
    ...calls.map((call) => [
      call.id,
      (call.agentId as unknown as { name?: string })?.name ?? "",
      call.direction,
      call.status,
      call.callerNumber,
      call.calledNumber,
      call.startedAt?.toISOString() ?? "",
      call.durationSeconds,
      call.avgResponseLatencyMs,
      call.sentimentLabel,
      call.costBreakdown?.total ?? 0,
      rounded((call.costBreakdown?.total ?? 0) * creditBillingSettings.markupMultiplier),
      call.costBreakdown?.llm ?? 0,
      call.costBreakdown?.stt ?? 0,
      call.costBreakdown?.tts ?? 0,
      call.costBreakdown?.telephony ?? 0,
      call.tags.join("|"),
      call.endReason,
    ]),
  ];
  response
    .status(200)
    .type("text/csv")
    .setHeader("Content-Disposition", `attachment; filename="calls-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(rows.map((row) => row.map(escapeCsv).join(",")).join("\n"));
}
