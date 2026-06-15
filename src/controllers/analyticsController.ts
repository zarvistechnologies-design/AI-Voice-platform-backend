import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { HttpError } from "../utils/httpError.js";

function ownerId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function dateRange(request: AuthenticatedRequest) {
  const days = Math.min(365, Math.max(1, Number(request.query.days) || 30));
  const to = typeof request.query.to === "string" ? new Date(request.query.to) : new Date();
  const from =
    typeof request.query.from === "string"
      ? new Date(request.query.from)
      : new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, "Analytics dates must be valid ISO dates.");
  }
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

export async function analyticsOverview(request: AuthenticatedRequest, response: Response) {
  const { from, to } = dateRange(request);
  const match: Record<string, unknown> = {
    ownerId: ownerId(request),
    createdAt: { $gte: from, $lte: to },
  };
  if (typeof request.query.agentId === "string" && request.query.agentId) {
    if (!Types.ObjectId.isValid(request.query.agentId)) throw new HttpError(400, "Invalid agent ID.");
    match.agentId = new Types.ObjectId(request.query.agentId);
  }

  const [summaryRows, timeSeries, statusBreakdown, directionBreakdown, agentPerformance, providerUsage] =
    await Promise.all([
      CallDetailRecordModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            completedCalls: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            failedCalls: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
            activeCalls: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
            totalDurationSeconds: { $sum: "$durationSeconds" },
            averageDurationSeconds: { $avg: "$durationSeconds" },
            averageLatencyMs: { $avg: "$avgResponseLatencyMs" },
            llmTokens: { $sum: "$llmTokens" },
            sttSeconds: { $sum: "$sttSeconds" },
            ttsCharacters: { $sum: "$ttsCharacters" },
            totalCost: { $sum: "$costBreakdown.total" },
          },
        },
      ]),
      CallDetailRecordModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            calls: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            durationSeconds: { $sum: "$durationSeconds" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      CallDetailRecordModel.aggregate([
        { $match: match },
        { $group: { _id: "$status", value: { $sum: 1 } } },
        { $sort: { value: -1 } },
      ]),
      CallDetailRecordModel.aggregate([
        { $match: match },
        { $group: { _id: "$direction", value: { $sum: 1 } } },
        { $sort: { value: -1 } },
      ]),
      CallDetailRecordModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$agentId",
            calls: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            durationSeconds: { $sum: "$durationSeconds" },
            averageLatencyMs: { $avg: "$avgResponseLatencyMs" },
          },
        },
        { $sort: { calls: -1 } },
        { $limit: 20 },
        {
          $lookup: {
            from: "voiceagents",
            localField: "_id",
            foreignField: "_id",
            as: "agent",
          },
        },
        { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            agentId: "$_id",
            name: { $ifNull: ["$agent.name", "Deleted agent"] },
            calls: 1,
            completed: 1,
            durationSeconds: 1,
            averageLatencyMs: { $round: [{ $ifNull: ["$averageLatencyMs", 0] }, 0] },
          },
        },
      ]),
      CallDetailRecordModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              llm: "$llmProvider",
              stt: "$sttProvider",
              tts: "$ttsProvider",
            },
            calls: { $sum: 1 },
            llmTokens: { $sum: "$llmTokens" },
            sttSeconds: { $sum: "$sttSeconds" },
            ttsCharacters: { $sum: "$ttsCharacters" },
          },
        },
        { $sort: { calls: -1 } },
      ]),
    ]);

  const raw = summaryRows[0] ?? {};
  const totalCalls = raw.totalCalls ?? 0;
  response.json({
    range: { from, to },
    summary: {
      totalCalls,
      completedCalls: raw.completedCalls ?? 0,
      failedCalls: raw.failedCalls ?? 0,
      activeCalls: raw.activeCalls ?? 0,
      completionRate: totalCalls ? Math.round(((raw.completedCalls ?? 0) / totalCalls) * 1000) / 10 : 0,
      totalDurationSeconds: raw.totalDurationSeconds ?? 0,
      averageDurationSeconds: Math.round(raw.averageDurationSeconds ?? 0),
      averageLatencyMs: Math.round(raw.averageLatencyMs ?? 0),
      llmTokens: raw.llmTokens ?? 0,
      sttSeconds: Math.round((raw.sttSeconds ?? 0) * 100) / 100,
      ttsCharacters: raw.ttsCharacters ?? 0,
      totalCost: raw.totalCost ?? 0,
    },
    timeSeries: timeSeries.map((item) => ({ date: item._id, calls: item.calls, completed: item.completed, durationSeconds: item.durationSeconds })),
    statusBreakdown: statusBreakdown.map((item) => ({ label: item._id, value: item.value })),
    directionBreakdown: directionBreakdown.map((item) => ({ label: item._id, value: item.value })),
    agentPerformance,
    providerUsage: providerUsage.map((item) => ({ providers: item._id, calls: item.calls, llmTokens: item.llmTokens, sttSeconds: item.sttSeconds, ttsCharacters: item.ttsCharacters })),
  });
}
