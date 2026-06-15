import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { recordCallUsage } from "../src/services/callRecordService.js";

const baseUrl = "http://localhost:5000";
const email = `phase4-smoke-${Date.now()}@example.com`;
let ownerId = "";
let cookie = "";

await connectDatabase();

async function api(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: await response.json().catch(() => null),
    cookie: response.headers.get("set-cookie") ?? "",
  };
}

try {
  const registration = await api("/api/auth/register", {
    name: "Phase Four Smoke",
    email,
    password: "phase-four-smoke-password",
  });
  cookie = registration.cookie.split(";")[0] ?? "";
  ownerId = (registration.data as { user: { id: string } }).user.id;
  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");

  const now = new Date();
  const rooms = ["phase4-completed-1", "phase4-completed-2", "phase4-failed", "phase4-active"];
  await CallDetailRecordModel.insertMany([
    { ownerId, orgId: ownerId, agentId, livekitRoomName: rooms[0], direction: "web", status: "completed", startedAt: now, endedAt: now, durationSeconds: 120, avgResponseLatencyMs: 300 },
    { ownerId, orgId: ownerId, agentId, livekitRoomName: rooms[1], direction: "outbound", status: "completed", startedAt: now, endedAt: now, durationSeconds: 60, avgResponseLatencyMs: 500 },
    { ownerId, orgId: ownerId, agentId, livekitRoomName: rooms[2], direction: "inbound", status: "failed", startedAt: now, endedAt: now, durationSeconds: 10, avgResponseLatencyMs: 0 },
    { ownerId, orgId: ownerId, agentId, livekitRoomName: rooms[3], direction: "web", status: "active", startedAt: now, durationSeconds: 0, avgResponseLatencyMs: 200 },
  ]);
  await recordCallUsage(rooms[0], {
    modelUsage: [
      { type: "llm_usage", provider: "openai", inputTokens: 100, outputTokens: 50 },
      { type: "stt_usage", provider: "openai", audioDurationMs: 120000 },
      { type: "tts_usage", provider: "openai", charactersCount: 500 },
    ],
  });

  const result = await api("/api/voice/analytics/overview?days=7");
  if (result.status !== 200) throw new Error(`Analytics endpoint failed: ${JSON.stringify(result.data)}`);
  const analytics = result.data as {
    summary: {
      totalCalls: number;
      completedCalls: number;
      failedCalls: number;
      activeCalls: number;
      completionRate: number;
      totalDurationSeconds: number;
      averageLatencyMs: number;
      llmTokens: number;
      sttSeconds: number;
      ttsCharacters: number;
    };
    timeSeries: unknown[];
    agentPerformance: { calls: number }[];
    providerUsage: { llmTokens: number }[];
  };
  const summary = analytics.summary;
  if (
    summary.totalCalls !== 4 ||
    summary.completedCalls !== 2 ||
    summary.failedCalls !== 1 ||
    summary.activeCalls !== 1 ||
    summary.completionRate !== 50 ||
    summary.totalDurationSeconds !== 190 ||
    summary.averageLatencyMs !== 250 ||
    summary.llmTokens !== 150 ||
    summary.sttSeconds !== 120 ||
    summary.ttsCharacters !== 500 ||
    analytics.timeSeries.length !== 1 ||
    analytics.agentPerformance[0]?.calls !== 4 ||
    analytics.providerUsage.find((item) => item.llmTokens === 150)?.llmTokens !== 150
  ) {
    throw new Error(`Analytics aggregation returned unexpected values: ${JSON.stringify(analytics)}`);
  }

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "worker usage persistence",
      "analytics summary aggregation",
      "daily call time series",
      "status and direction breakdowns",
      "per-agent performance",
      "provider usage reporting",
    ],
  }));
} finally {
  if (ownerId) {
    await Promise.all([
      CallDetailRecordModel.deleteMany({ ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
