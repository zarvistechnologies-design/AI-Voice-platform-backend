import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { BillingSubscriptionModel } from "../src/models/BillingSubscription.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const suffix = Date.now();
let ownerId = "";
let cookie = "";
const allDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const livekitConfigured = Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret);

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
  return { status: response.status, data: await response.json().catch(() => null), cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Ten Smoke", email: `phase10-${suffix}@example.com`, password: "phase-ten-smoke-password" },
  });
  cookie = registration.cookie;
  ownerId = (registration.data as { user: { id: string } }).user.id;

  const templateList = await api("/api/voice/agent-templates");
  const templates = (templateList.data as { templates?: { id: string; name: string }[] }).templates ?? [];
  if (templateList.status !== 200 || !templates.some((template) => template.id === "support")) {
    throw new Error(`Agent templates missing: ${JSON.stringify(templateList.data)}`);
  }

  const created = await api("/api/voice/agent-templates/support", { method: "POST" });
  const agent = (created.data as { agent?: { _id: string; name: string } }).agent;
  if (created.status !== 201 || !agent?._id || agent.name !== "Customer Support") {
    throw new Error(`Template agent creation failed: ${JSON.stringify(created.data)}`);
  }

  const agentId = agent._id;
  const schedule = allDays.map((day) => ({ day, enabled: true, start: "00:00", end: "23:59" }));
  const updated = await api(`/api/voice/agents/${agentId}`, {
    method: "PUT",
    body: {
      status: "Live",
      maxConcurrentCalls: 2,
      voiceSpeed: 1.35,
      voicePitch: 4,
      interruptionSensitivity: "high",
      backgroundNoise: "cafe",
      callbackEmail: "ops@example.com",
      businessHoursEnabled: true,
      businessHours: { timezone: "Asia/Kolkata", schedule },
      behavior: { transferPhone: "+14155550123" },
    },
  });
  const saved = (updated.data as { agent?: Record<string, unknown> }).agent ?? {};
  if (
    updated.status !== 200 ||
    saved.maxConcurrentCalls !== 2 ||
    saved.voiceSpeed !== 1.35 ||
    saved.voicePitch !== 4 ||
    saved.interruptionSensitivity !== "high" ||
    saved.backgroundNoise !== "cafe" ||
    saved.callbackEmail !== "ops@example.com" ||
    (saved.businessHours as { timezone?: string } | undefined)?.timezone !== "Asia/Kolkata"
  ) {
    throw new Error(`Advanced runtime settings failed: ${JSON.stringify(updated.data)}`);
  }

  await api(`/api/voice/agents/${agentId}`, { method: "PUT", body: { status: "Paused" } });
  const paused = await api("/api/voice/web-call-token", { method: "POST", body: { agentId } });
  if (paused.status !== 409 || !String((paused.data as { message?: string })?.message).includes("paused")) {
    throw new Error("Paused agent was allowed to start a browser call.");
  }

  await api(`/api/voice/agents/${agentId}`, {
    method: "PUT",
    body: {
      status: "Live",
      businessHoursEnabled: true,
      businessHours: {
        timezone: "UTC",
        schedule: allDays.map((day) => ({ day, enabled: false, start: "09:00", end: "17:00" })),
      },
    },
  });
  const outsideHours = await api("/api/voice/web-call-token", { method: "POST", body: { agentId } });
  if (outsideHours.status !== 409 || !String((outsideHours.data as { message?: string })?.message).includes("business hours")) {
    throw new Error("Business-hours guard did not block browser calls.");
  }

  await api(`/api/voice/agents/${agentId}`, {
    method: "PUT",
    body: { businessHoursEnabled: false, maxConcurrentCalls: 1 },
  });
  await CallDetailRecordModel.create({
    ownerId,
    orgId: ownerId,
    agentId,
    livekitRoomName: `phase10-active-${suffix}`,
    direction: "web",
    status: "active",
    startedAt: new Date(),
  });
  const concurrent = await api("/api/voice/web-call-token", { method: "POST", body: { agentId } });
  if (concurrent.status !== 429 || !String((concurrent.data as { message?: string })?.message).includes("concurrent call limit")) {
    throw new Error("Concurrent-call guard did not block browser calls.");
  }

  await CallDetailRecordModel.deleteMany({ ownerId, livekitRoomName: `phase10-active-${suffix}` });
  await api(`/api/voice/agents/${agentId}`, {
    method: "PUT",
    body: { maxConcurrentCalls: 3, businessHoursEnabled: false, voiceSpeed: 1.2, voicePitch: -2 },
  });
  const tokenResult = await api("/api/voice/web-call-token", { method: "POST", body: { agentId } });
  if (livekitConfigured) {
    if (tokenResult.status !== 200) throw new Error(`Browser call token failed: ${JSON.stringify(tokenResult.data)}`);
    const decoded = jwt.decode((tokenResult.data as { participantToken: string }).participantToken) as { metadata?: string };
    const runtime = JSON.parse(decoded.metadata ?? "{}") as {
      voiceSpeed?: number;
      voicePitch?: number;
      interruptionSensitivity?: string;
      backgroundNoise?: string;
      behavior?: { transferPhone?: string };
    };
    if (
      runtime.voiceSpeed !== 1.2 ||
      runtime.voicePitch !== -2 ||
      runtime.interruptionSensitivity !== "high" ||
      runtime.backgroundNoise !== "cafe" ||
      runtime.behavior?.transferPhone !== "+14155550123"
    ) {
      throw new Error(`Runtime metadata mismatch: ${JSON.stringify(runtime)}`);
    }
  } else if (tokenResult.status !== 503) {
    throw new Error("Unconfigured LiveKit did not fail clearly.");
  }

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "agent template catalog",
      "template agent creation",
      "advanced voice runtime persistence",
      "paused agent call guard",
      "business-hours call guard",
      "concurrent-call guard",
      livekitConfigured ? "browser token runtime metadata" : "clear unconfigured LiveKit response",
    ],
  }));
} finally {
  server.close();
  if (ownerId) {
    await Promise.all([
      AuthSessionModel.deleteMany({ userId: ownerId }),
      BillingSubscriptionModel.deleteMany({ orgId: ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      EmailDeliveryModel.deleteMany({ userId: ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
