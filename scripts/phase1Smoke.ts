import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { appendTranscriptItem } from "../src/services/callRecordService.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";

const baseUrl = `http://localhost:${env.port}`;
const email = `phase1-smoke-${Date.now()}@example.com`;
let ownerId = "";
let cookie = "";

await connectDatabase();

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data };
}

async function sendLivekitWebhook(event: string, roomName: string) {
  const body = JSON.stringify({
    event,
    room: {
      sid: "RM_phase1_smoke",
      name: roomName,
      emptyTimeout: 60,
      departureTimeout: 30,
    },
  });
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  const response = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: {
      Authorization: await token.toJwt(),
      "Content-Type": "application/webhook+json",
    },
    body,
  });
  if (response.status !== 204) {
    throw new Error(`Signed LiveKit webhook failed with status ${response.status}.`);
  }
}

try {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Phase One Smoke",
      email,
      password: "phase-one-smoke-password",
    }),
  });
  if (registered.response.status !== 201) {
    throw new Error(`Registration failed: ${JSON.stringify(registered.data)}`);
  }
  const setCookie = registered.response.headers.get("set-cookie") ?? "";
  if (!setCookie.toLowerCase().includes("httponly")) {
    throw new Error("Authentication cookie is not HttpOnly.");
  }
  if (registered.data && typeof registered.data === "object" && "token" in registered.data) {
    throw new Error("Authentication response exposed a JWT in JSON.");
  }
  cookie = setCookie.split(";")[0] ?? "";
  ownerId = (registered.data as { user: { id: string } }).user.id;

  const agentResult = await request("/api/voice/agents");
  const agent = (agentResult.data as { agents: { _id: string }[] }).agents[0];
  if (!agent) throw new Error("Starter voice agent was not created.");

  const tokenResult = await request("/api/voice/web-call-token", {
    method: "POST",
    body: JSON.stringify({ agentId: agent._id }),
  });
  if (tokenResult.response.status !== 200) {
    throw new Error(`Web call token failed: ${JSON.stringify(tokenResult.data)}`);
  }
  const { callId, roomName } = tokenResult.data as { callId?: string; roomName?: string };
  if (!callId || !roomName) throw new Error("Web call did not create a call record.");

  const listResult = await request("/api/voice/calls?limit=10");
  const calls = (listResult.data as { calls: { _id: string }[] }).calls;
  if (!calls.some((call) => call._id === callId)) {
    throw new Error("Created call record was not returned by the list API.");
  }

  await sendLivekitWebhook("room_finished", roomName);
  await appendTranscriptItem({
    roomName,
    itemId: "phase1-smoke-transcript",
    role: "assistant",
    text: "Phase one transcript persistence check.",
  });
  const detailResult = await request(`/api/voice/calls/${callId}`);
  const detail = (
    detailResult.data as {
      call?: { _id: string; status: string; transcript: { itemId: string }[] };
    }
  ).call;
  if (detail?._id !== callId) {
    throw new Error("Call detail API did not return the created call.");
  }
  if (detail.status !== "completed") {
    throw new Error("Signed room_finished webhook did not finalize the call.");
  }
  if (!detail.transcript.some((item) => item.itemId === "phase1-smoke-transcript")) {
    throw new Error("Call transcript item was not persisted.");
  }

  const logoutResult = await request("/api/auth/logout", { method: "POST" });
  if (logoutResult.response.status !== 204) throw new Error("Logout failed.");
  cookie = "";
  const unauthorized = await request("/api/voice/calls");
  if (unauthorized.response.status !== 401) {
    throw new Error("Protected call API accepted a request without a session cookie.");
  }

  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "httpOnly cookie auth",
        "JWT absent from auth JSON",
        "starter agent creation",
        "CDR creation before web call",
        "call list API",
        "call detail API",
        "signed LiveKit webhook finalization",
        "transcript persistence",
        "logout and protected-route rejection",
      ],
    }),
  );
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
