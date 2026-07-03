import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { AgentCampaignSlotModel } from "../src/models/AgentCampaignSlot.js";
import { connectDatabase } from "../src/config/database.js";
import { AuditLogModel } from "../src/models/AuditLog.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { CampaignLeadModel } from "../src/models/CampaignLead.js";
import { CampaignModel } from "../src/models/Campaign.js";
import { ContactSuppressionModel } from "../src/models/ContactSuppression.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const suffix = Date.now();
let userId = "";
let orgId = "";

await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let token = "";

async function api(path: string, input: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${input.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data as Record<string, any>;
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Campaign Smoke User", email: `campaign-${suffix}@example.com`, password: "campaign-smoke-password" },
  });
  token = registration.token;
  userId = registration.user.id;
  orgId = registration.organization._id ?? registration.organization.id;

  const agentResult = await api("/api/voice/agents?view=summary");
  const agentId = agentResult.agents[0]._id;
  const phone = await PhoneNumberModel.create({
    ownerId: orgId,
    number: "+919900000001",
    label: "Campaign smoke caller ID",
    direction: "Outbound",
    agentId,
    outboundTrunkId: "smoke-trunk",
    status: "Ready",
  });

  await api("/api/voice/campaign-suppressions", {
    method: "POST",
    body: { phone: "+919900000003", reason: "Smoke-test opt-out" },
  });
  const created = await api("/api/voice/campaigns", {
    method: "POST",
    body: {
      idempotencyKey: `campaign-smoke-${suffix}`,
      name: "Scheduled production smoke",
      agentId,
      phoneNumberId: phone.id,
      timezone: "Asia/Kolkata",
      windowStart: "09:00",
      windowEnd: "18:00",
      dailyLimit: 1000,
      concurrency: 5,
      maxAttempts: 3,
      retryGapSeconds: 3600,
      goal: "Validate durable campaign scheduling",
      successCriteria: "Campaign remains scheduled without dialing",
      respectDnc: true,
      requireConsentLine: true,
      detectVoicemail: true,
    },
  });
  const campaignId = created.campaign._id;
  const leadBatch = {
    leads: [
      { row: 2, phone: "+919900000002", name: "Callable lead" },
      { row: 3, phone: "+919900000003", name: "Suppressed lead" },
      { row: 4, phone: "+919900000004", name: "CSV opt-out", customFields: { dnc: "yes" } },
    ],
  };
  const uploaded = await api(`/api/voice/campaigns/${campaignId}/leads`, { method: "POST", body: leadBatch });
  if (uploaded.inserted !== 3 || uploaded.suppressed !== 2) throw new Error(`Suppression result was incorrect: ${JSON.stringify(uploaded)}`);
  const duplicateUpload = await api(`/api/voice/campaigns/${campaignId}/leads`, { method: "POST", body: leadBatch });
  if (duplicateUpload.inserted !== 0 || duplicateUpload.duplicates !== 3) throw new Error("Lead upload was not idempotent.");

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const launched = await api(`/api/voice/campaigns/${campaignId}/launch`, {
    method: "POST",
    body: { mode: "schedule", scheduledAt: future },
  });
  if (launched.campaign.status !== "scheduled" || launched.campaign.stats.suppressed !== 2) {
    throw new Error(`Scheduled campaign state was incorrect: ${JSON.stringify(launched.campaign)}`);
  }
  const paused = await api(`/api/voice/campaigns/${campaignId}/pause`, { method: "POST" });
  if (paused.campaign.status !== "paused") throw new Error("Campaign did not pause.");
  const resumed = await api(`/api/voice/campaigns/${campaignId}/resume`, { method: "POST" });
  if (resumed.campaign.status !== "scheduled") throw new Error("Future campaign did not resume as scheduled.");
  const cancelled = await api(`/api/voice/campaigns/${campaignId}/cancel`, { method: "POST" });
  if (cancelled.campaign.status !== "cancelled") throw new Error("Campaign did not cancel.");

  console.log(JSON.stringify({
    passed: true,
    checks: ["durable create", "batched idempotent leads", "DNC suppression", "future scheduling", "pause/resume", "cancel"],
  }));
} finally {
  server.close();
  if (orgId) {
    const campaigns = await CampaignModel.find({ ownerId: orgId }).select("_id");
    await Promise.all([
      CampaignLeadModel.deleteMany({ ownerId: orgId }),
      AgentCampaignSlotModel.deleteMany({ ownerId: orgId }),
      CampaignModel.deleteMany({ ownerId: orgId }),
      ContactSuppressionModel.deleteMany({ ownerId: orgId }),
      PhoneNumberModel.deleteMany({ ownerId: orgId }),
      VoiceAgentModel.deleteMany({ ownerId: orgId }),
      AuditLogModel.deleteMany({ orgId }),
      AuthSessionModel.deleteMany({ userId }),
      EmailDeliveryModel.deleteMany({ userId }),
      OrganizationMemberModel.deleteMany({ orgId }),
      OrganizationModel.deleteOne({ _id: orgId }),
      UserModel.deleteOne({ _id: userId }),
    ]);
    void campaigns;
  }
  await mongoose.disconnect();
}
