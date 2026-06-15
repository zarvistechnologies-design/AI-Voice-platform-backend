import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
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

export async function listCalls(request: AuthenticatedRequest, response: Response) {
  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
  const filters = callFilters(request);
  const [calls, total] = await Promise.all([
    CallDetailRecordModel.find(filters)
      .populate("agentId", "name team")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CallDetailRecordModel.countDocuments(filters),
  ]);
  response.json({ calls, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}

export async function getCall(request: AuthenticatedRequest, response: Response) {
  const call = await CallDetailRecordModel.findOne({
    _id: request.params.callId,
    ownerId: ownerId(request),
  }).populate("agentId", "name team");
  if (!call) throw new HttpError(404, "Call record not found.");
  response.json({ call });
}

export async function exportCallsCsv(request: AuthenticatedRequest, response: Response) {
  const calls = await CallDetailRecordModel.find(callFilters(request))
    .populate("agentId", "name")
    .sort({ createdAt: -1 })
    .limit(10000);
  const rows = [
    ["Call ID", "Agent", "Direction", "Status", "Caller", "Called", "Started", "Duration (seconds)", "Latency (ms)", "Sentiment", "Cost (USD)", "Tags", "End reason"],
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
