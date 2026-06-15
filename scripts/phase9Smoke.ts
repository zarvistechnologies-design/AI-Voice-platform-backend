import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { completeCall, recordCallUsage } from "../src/services/callRecordService.js";

const suffix = Date.now();
let ownerId = "";
let cookie = "";
await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(path: string, input: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: { ...(input.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "", requestId: response.headers.get("x-request-id") };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Nine Smoke", email: `phase9-${suffix}@example.com`, password: "phase-nine-password" },
  });
  cookie = registration.cookie;
  ownerId = (registration.data as { user: { id: string } }).user.id;
  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");

  const roomName = `phase9-${suffix}`;
  await CallDetailRecordModel.create({
    ownerId,
    orgId: ownerId,
    agentId,
    livekitRoomName: roomName,
    direction: "web",
    status: "active",
    startedAt: new Date(Date.now() - 120000),
    transcript: [
      { itemId: "one", role: "user", text: "Thank you, this appointment booking is great and helpful.", timestamp: new Date(), interrupted: false },
      { itemId: "two", role: "assistant", text: "Your appointment is resolved.", timestamp: new Date(), interrupted: false },
    ],
  });
  await recordCallUsage(roomName, {
    modelUsage: [
      { type: "llm_usage", provider: "openai", inputTokens: 1000, outputTokens: 500 },
      { type: "stt_usage", provider: "openai", audioDurationMs: 120000 },
      { type: "tts_usage", provider: "openai", charactersCount: 1000 },
    ],
  });
  const completed = await completeCall(roomName);
  if (!completed || completed.sentimentLabel !== "positive" || !completed.tags.includes("appointment") || (completed.costBreakdown?.total ?? 0) <= 0) {
    throw new Error(`Call intelligence failed: ${JSON.stringify(completed?.toObject())}`);
  }

  const searched = await api("/api/voice/calls?search=appointment&minDuration=60&sentiment=positive");
  if (searched.status !== 200 || (searched.data as { pagination: { total: number } }).pagination.total !== 1) {
    throw new Error("Transcript/duration/sentiment search failed.");
  }
  const excluded = await api("/api/voice/calls?minDuration=500");
  if ((excluded.data as { pagination: { total: number } }).pagination.total !== 0) throw new Error("Minimum duration filter failed.");
  const csvResponse = await fetch(`${baseUrl}/api/voice/calls/export.csv?search=appointment`, { headers: { Cookie: cookie } });
  const csv = await csvResponse.text();
  if (!csv.includes("Sentiment") || !csv.includes("positive") || !csv.includes("appointment")) throw new Error("Enriched CSV export failed.");
  const health = await fetch(`${baseUrl}/health`);
  if (!health.headers.get("x-request-id") || (await health.json() as { checks?: { database?: string } }).checks?.database !== "connected") {
    throw new Error("Request ID or detailed health check failed.");
  }

  console.log(JSON.stringify({
    passed: true,
    checks: ["provider cost calculation", "post-call sentiment", "automatic tags", "transcript search", "duration and sentiment filters", "enriched CSV export", "request ID tracing", "detailed health check"],
  }));
} finally {
  server.close();
  if (ownerId) {
    await Promise.all([
      AuthSessionModel.deleteMany({ userId: ownerId }),
      EmailDeliveryModel.deleteMany({ userId: ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
