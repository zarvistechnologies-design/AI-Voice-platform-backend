import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { creditBillingSettings } from "../services/billingService.js";
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

function callFilters(request: AuthenticatedRequest) {
  const filters: Record<string, unknown> = { ownerId: ownerId(request) };
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
    filters.$or = [{ "transcript.text": regex }, { callerNumber: regex }, { calledNumber: regex }, { tags: regex }];
  }
  const startedAt: Record<string, Date> = {};
  if (typeof request.query.from === "string" && request.query.from) {
    startedAt.$gte = new Date(request.query.from);
  }
  if (typeof request.query.to === "string" && request.query.to) {
    startedAt.$lte = new Date(request.query.to);
  }
  if (Object.keys(startedAt).length) filters.startedAt = startedAt;
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

function callId(call: CallLike) {
  return call.id ?? String(call._id ?? "");
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
    const raw = call.toObject ? call.toObject() : { ...call };
    const cost = call.costBreakdown ?? {};
    const id = callId(call);
    const callTransactions = byCall.get(id) ?? [];
    const chargedCredits = rounded(
      callTransactions.reduce((sum, transaction) => sum + Math.abs(transaction.amountCredits), 0),
    );
    const estimatedCharge = rounded((cost.total ?? 0) * creditBillingSettings.markupMultiplier);

    return {
      ...raw,
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
      .populate("agentId", "name team")
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
  }).populate("agentId", "name team");
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
