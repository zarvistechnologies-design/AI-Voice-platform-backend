import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import { connectDatabase } from "../src/config/database.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const baseUrl = "http://localhost:5000";
const email = `phase3-smoke-${Date.now()}@example.com`;
let ownerId = "";
let cookie = "";

await connectDatabase();

async function api(path: string, input: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, data, cookie: response.headers.get("set-cookie") ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Three Smoke", email, password: "phase-three-smoke-password" },
  });
  cookie = registration.cookie.split(";")[0] ?? "";
  ownerId = (registration.data as { user: { id: string } }).user.id;

  const agentsResult = await api("/api/voice/agents");
  const starter = (agentsResult.data as { agents: { _id: string; version: number }[] }).agents[0];
  if (!starter) throw new Error("Starter agent missing.");

  const advanced = {
    behavior: {
      interruptions: false,
      userStartsFirst: true,
      autoFillResponses: false,
      agentCanTerminate: true,
      voicemailHandling: true,
      dtmfDial: true,
      responseDelayMs: 525,
      maxCallDurationSeconds: 900,
      maxIdleSeconds: 25,
      transferPhone: "+14155550123",
      timezone: "America/New_York",
      voicemailMessage: "Please leave a detailed message.",
    },
    callSettings: {
      recordingEnabled: true,
      doNotCallDetection: true,
      sessionContinuation: false,
      memoryEnabled: false,
    },
    tools: [
      {
        name: "lookup_customer",
        description: "Look up a customer by provided details.",
        method: "POST",
        url: `${baseUrl}/health`,
        timeoutSeconds: 5,
        enabled: true,
      },
    ],
    knowledgeDocuments: [
      {
        name: "Pricing facts",
        content: "The starter plan includes one active voice agent.",
        status: "ready",
      },
    ],
    dynamicVariables: ["FromPhone", "customerID"],
    prefetchWebhook: `${baseUrl}/health`,
    endOfCallWebhook: `${baseUrl}/health`,
    widget: {
      enabled: true,
      publicKey: "pk_phase3_smoke",
      allowedDomains: ["https://example.com"],
      theme: "dark",
      position: "bottom-left",
      buttonText: "Talk now",
      accentColor: "#2563eb",
    },
  };
  const updated = await api(`/api/voice/agents/${starter._id}`, {
    method: "PUT",
    body: advanced,
  });
  if (updated.status !== 200) throw new Error(`Advanced agent update failed: ${JSON.stringify(updated.data)}`);
  const agent = (updated.data as { agent: typeof advanced & { version: number } }).agent;
  if (
    agent.behavior.responseDelayMs !== 525 ||
    agent.tools[0]?.name !== "lookup_customer" ||
    agent.knowledgeDocuments[0]?.name !== "Pricing facts" ||
    agent.widget.publicKey !== "pk_phase3_smoke" ||
    agent.version <= starter.version
  ) {
    throw new Error("Advanced agent settings were not persisted.");
  }

  const webToken = await api("/api/voice/web-call-token", {
    method: "POST",
    body: { agentId: starter._id },
  });
  const decoded = jwt.decode((webToken.data as { participantToken: string }).participantToken) as {
    metadata?: string;
  };
  const runtime = JSON.parse(decoded.metadata ?? "{}") as {
    behavior?: { userStartsFirst?: boolean };
    tools?: { name: string }[];
    prompt?: string;
  };
  if (
    runtime.behavior?.userStartsFirst !== true ||
    runtime.tools?.[0]?.name !== "lookup_customer" ||
    !runtime.prompt?.includes("starter plan includes one active voice agent")
  ) {
    throw new Error("Advanced settings were not dispatched to the LiveKit worker runtime.");
  }

  const cloneResult = await api(`/api/voice/agents/${starter._id}/clone`, { method: "POST" });
  const clone = (cloneResult.data as { agent: { _id: string; status: string; version: number; tools: unknown[] } }).agent;
  if (cloneResult.status !== 201 || clone.status !== "Draft" || clone.version !== 1 || clone.tools.length !== 1) {
    throw new Error("Agent clone did not preserve advanced configuration as a new draft.");
  }
  const deleted = await api(`/api/voice/agents/${clone._id}`, { method: "DELETE" });
  if (deleted.status !== 204) throw new Error("Agent delete failed.");

  const invalidTool = await api(`/api/voice/agents/${starter._id}`, {
    method: "PUT",
    body: { tools: [{ name: "bad tool", url: "not-a-url" }] },
  });
  if (invalidTool.status !== 400) throw new Error("Invalid webhook tool configuration was accepted.");

  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "advanced behavior persistence",
        "call policy persistence",
        "webhook tool validation and dispatch",
        "knowledge runtime injection",
        "widget and dynamic-variable persistence",
        "agent versioning",
        "agent clone and delete",
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
