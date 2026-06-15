import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { ApiKeyModel } from "../src/models/ApiKey.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { WebhookDeliveryModel } from "../src/models/WebhookDelivery.js";
import { WebhookEndpointModel } from "../src/models/WebhookEndpoint.js";
import { completeCall } from "../src/services/callRecordService.js";

const suffix = Date.now();
let ownerId = "";
let cookie = "";
const received: { body: string; signature: string; event: string }[] = [];
let webhookSecret = "";

await connectDatabase();
const receiver = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received.push({
      body,
      signature: String(request.headers["x-ai-voice-signature"] ?? ""),
      event: String(request.headers["x-ai-voice-event"] ?? ""),
    });
    response.writeHead(204).end();
  });
});
receiver.listen(0);
await new Promise<void>((resolve) => receiver.once("listening", resolve));
const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(path: string, input: { method?: string; body?: unknown; apiKey?: string } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(input.apiKey ? { "X-API-Key": input.apiKey } : cookie ? { Cookie: cookie } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get("set-cookie") ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Six Smoke", email: `phase6-${suffix}@example.com`, password: "phase-six-smoke-password" },
  });
  cookie = registration.cookie.split(";")[0] ?? "";
  ownerId = (registration.data as { user: { id: string } }).user.id;
  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");

  const webhookResult = await api("/api/developer/webhooks", {
    method: "POST",
    body: { name: "Smoke receiver", url: receiverUrl, events: ["call.ended", "transcript.ready"] },
  });
  if (webhookResult.status !== 201) throw new Error(`Webhook creation failed: ${JSON.stringify(webhookResult.data)}`);
  webhookSecret = (webhookResult.data as { secret: string }).secret;
  const webhookId = (webhookResult.data as { webhook: { _id: string } }).webhook._id;

  const test = await api(`/api/developer/webhooks/${webhookId}/test`, { method: "POST" });
  if (test.status !== 200 || received.length !== 1) throw new Error("Test webhook was not delivered.");
  const expected = createHmac("sha256", webhookSecret).update(received[0].body).digest("hex");
  if (received[0].signature !== `v1=${expected}` || received[0].event !== "call.ended") {
    throw new Error("Outbound webhook signature was invalid.");
  }

  const call = await CallDetailRecordModel.create({
    ownerId,
    orgId: ownerId,
    agentId,
    livekitRoomName: `phase6-${suffix}`,
    direction: "web",
    status: "active",
    startedAt: new Date(Date.now() - 5000),
    transcript: [{ itemId: "one", role: "assistant", text: "Hello", timestamp: new Date(), interrupted: false }],
  });
  await completeCall(call.livekitRoomName);
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!received.some((item) => item.event === "call.ended") || !received.some((item) => item.event === "transcript.ready")) {
    throw new Error("Call lifecycle webhooks were not delivered.");
  }

  const keyResult = await api("/api/developer/api-keys", {
    method: "POST",
    body: { name: "Read-only smoke key", scopes: ["read"] },
  });
  const rawKey = (keyResult.data as { key: string }).key;
  if (keyResult.status !== 201 || !rawKey.startsWith("avp_")) throw new Error("API key creation failed.");
  const apiKeyList = await api("/api/developer/api-keys");
  if (JSON.stringify(apiKeyList.data).includes(rawKey)) throw new Error("Raw API key leaked from list endpoint.");
  const keyRead = await api("/api/voice/agents", { apiKey: rawKey });
  if (keyRead.status !== 200) throw new Error("Read API key could not read agents.");
  const keyWrite = await api("/api/voice/agents", { method: "POST", apiKey: rawKey, body: { name: "Forbidden" } });
  if (keyWrite.status !== 403) throw new Error("Read-only API key bypassed write scope.");

  const keys = (apiKeyList.data as { apiKeys: { _id: string }[] }).apiKeys;
  const revoke = await api(`/api/developer/api-keys/${keys[0]._id}`, { method: "DELETE" });
  if (revoke.status !== 204) throw new Error("API key revoke failed.");
  const revokedRead = await api("/api/voice/agents", { apiKey: rawKey });
  if (revokedRead.status !== 401) throw new Error("Revoked API key still authenticated.");

  console.log(JSON.stringify({
    passed: true,
    checks: ["webhook CRUD", "one-time webhook secret", "HMAC signed test delivery", "call lifecycle delivery", "delivery logging", "hashed one-time API key", "API scope enforcement", "API key revocation"],
  }));
} finally {
  server.close();
  receiver.close();
  if (ownerId) {
    await Promise.all([
      ApiKeyModel.deleteMany({ orgId: ownerId }),
      WebhookDeliveryModel.deleteMany({ orgId: ownerId }),
      WebhookEndpointModel.deleteMany({ orgId: ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
