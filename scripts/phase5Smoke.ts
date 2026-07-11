import mongoose from "mongoose";
import type { AddressInfo } from "node:net";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { BillingInvoiceModel } from "../src/models/BillingInvoice.js";
import { BillingSubscriptionModel } from "../src/models/BillingSubscription.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const suffix = Date.now();
let ownerId = "";
let cookie = "";
const originalWebhookSecret = env.stripeWebhookSecret;
env.stripeWebhookSecret = `phase5-webhook-${suffix}`;

await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(path: string, input: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(input.raw ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...input.headers,
    },
    body: input.raw ?? (input.body ? JSON.stringify(input.body) : undefined),
  });
  return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get("set-cookie") ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Five Smoke", email: `phase5-${suffix}@example.com`, password: "phase-five-smoke-password" },
  });
  cookie = registration.cookie.split(";")[0] ?? "";
  ownerId = (registration.data as { user: { id: string } }).user.id;

  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");

  await CallDetailRecordModel.create({
    ownerId,
    orgId: ownerId,
    agentId,
    livekitRoomName: `phase5-${suffix}`,
    direction: "web",
    status: "completed",
    startedAt: new Date(),
    endedAt: new Date(),
    durationSeconds: 3660,
    costBreakdown: { providerCost: 1.25, customerCost: 1.25, total: 1.25 },
  });

  const summary = await api("/api/billing/summary");
  const billing = summary.data as { currentPlan: { id: string }; plans: unknown[]; usage: { minutes: number; providerCost: number } };
  if (summary.status !== 200 || billing.currentPlan.id !== "free" || billing.plans.length !== 1 || billing.usage.minutes !== 61 || billing.usage.providerCost !== 1.25) {
    throw new Error(`Billing summary mismatch: ${JSON.stringify(summary.data)}`);
  }

  console.log(JSON.stringify({
    passed: true,
    checks: ["pay-as-you-go billing summary and usage metering"],
  }));
} finally {
  env.stripeWebhookSecret = originalWebhookSecret;
  server.close();
  if (ownerId) {
    await Promise.all([
      BillingInvoiceModel.deleteMany({ orgId: ownerId }),
      BillingSubscriptionModel.deleteMany({ orgId: ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
