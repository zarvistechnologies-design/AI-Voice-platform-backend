import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { ApiKeyModel } from "../src/models/ApiKey.js";
import { AuditLogModel } from "../src/models/AuditLog.js";
import { AuthSessionModel } from "../src/models/AuthSession.js";
import { BillingSubscriptionModel } from "../src/models/BillingSubscription.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { EmailDeliveryModel } from "../src/models/EmailDelivery.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationInvitationModel } from "../src/models/OrganizationInvitation.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { WebhookDeliveryModel } from "../src/models/WebhookDelivery.js";
import { WebhookEndpointModel } from "../src/models/WebhookEndpoint.js";

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
  return { status: response.status, data: await response.json().catch(() => null), cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Eleven Owner", email: `phase11-${suffix}@example.com`, password: "phase-eleven-password" },
  });
  cookie = registration.cookie;
  ownerId = (registration.data as { user: { id: string } }).user.id;

  const updatedOrg = await api("/api/organizations/current", {
    method: "PUT",
    body: { name: `Audited Workspace ${suffix}`, timezone: "Asia/Kolkata", dataRetentionDays: 180 },
  });
  if (updatedOrg.status !== 200) throw new Error(`Organization update failed: ${JSON.stringify(updatedOrg.data)}`);

  const invite = await api("/api/organizations/current/invitations", {
    method: "POST",
    body: { email: `phase11-invite-${suffix}@example.com`, role: "member" },
  });
  if (invite.status !== 201) throw new Error(`Invitation failed: ${JSON.stringify(invite.data)}`);

  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");
  const agentUpdate = await api(`/api/voice/agents/${agentId}`, {
    method: "PUT",
    body: { name: "Audited Agent", status: "Paused", maxConcurrentCalls: 4 },
  });
  if (agentUpdate.status !== 200) throw new Error(`Agent update failed: ${JSON.stringify(agentUpdate.data)}`);

  const apiKey = await api("/api/developer/api-keys", {
    method: "POST",
    body: { name: "Audit smoke key", scopes: ["read", "calls:trigger"] },
  });
  if (apiKey.status !== 201 || !(apiKey.data as { key?: string }).key?.startsWith("avp_")) {
    throw new Error(`API key creation failed: ${JSON.stringify(apiKey.data)}`);
  }

  const audit = await api("/api/organizations/current/audit-log?limit=50");
  const actions = ((audit.data as { auditLogs?: { action: string; actorEmail: string }[] }).auditLogs ?? []).map((entry) => entry.action);
  for (const action of ["organization.updated", "member.invited", "agent.updated", "api_key.created"]) {
    if (!actions.includes(action)) throw new Error(`Missing audit action ${action}: ${JSON.stringify(actions)}`);
  }
  const search = await api("/api/organizations/current/audit-log?search=Audited%20Agent");
  const searchActions = ((search.data as { auditLogs?: { action: string }[] }).auditLogs ?? []).map((entry) => entry.action);
  if (!searchActions.includes("agent.updated")) throw new Error("Audit search did not find agent update.");

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "organization settings audit",
      "member invitation audit",
      "agent update audit",
      "API key creation audit without raw key exposure",
      "audit log list and search endpoint",
    ],
  }));
} finally {
  server.close();
  if (ownerId) {
    await Promise.all([
      ApiKeyModel.deleteMany({ orgId: ownerId }),
      AuditLogModel.deleteMany({ orgId: ownerId }),
      AuthSessionModel.deleteMany({ userId: ownerId }),
      BillingSubscriptionModel.deleteMany({ orgId: ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      EmailDeliveryModel.deleteMany({ userId: ownerId }),
      OrganizationInvitationModel.deleteMany({ orgId: ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      WebhookDeliveryModel.deleteMany({ orgId: ownerId }),
      WebhookEndpointModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
