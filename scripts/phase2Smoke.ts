import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { BillingSubscriptionModel } from "../src/models/BillingSubscription.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationInvitationModel } from "../src/models/OrganizationInvitation.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

const baseUrl = "http://localhost:5000";
const suffix = Date.now();
const userIds: string[] = [];
const orgIds: string[] = [];

await connectDatabase();

async function api(
  path: string,
  input: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(input.cookie ? { Cookie: input.cookie } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return {
    status: response.status,
    data,
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

async function register(name: string, email: string) {
  const result = await api("/api/auth/register", {
    method: "POST",
    body: { name, email, password: "phase-two-smoke-password" },
  });
  if (result.status !== 201 || !result.cookie) {
    throw new Error(`Could not register ${email}: ${JSON.stringify(result.data)}`);
  }
  const payload = result.data as {
    user: { id: string };
    organization: { _id: string };
  };
  userIds.push(payload.user.id);
  orgIds.push(payload.organization._id);
  return { cookie: result.cookie, userId: payload.user.id, orgId: payload.organization._id };
}

try {
  const owner = await register("Phase Two Owner", `phase2-owner-${suffix}@example.com`);
  const member = await register("Phase Two Member", `phase2-member-${suffix}@example.com`);

  const created = await api("/api/organizations", {
    method: "POST",
    cookie: owner.cookie,
    body: { name: `Shared workspace ${suffix}` },
  });
  if (created.status !== 201 || !created.cookie) throw new Error("Organization creation failed.");
  const sharedOrgId = (created.data as { organization: { _id: string } }).organization._id;
  orgIds.push(sharedOrgId);
  const ownerSharedCookie = created.cookie;
  await BillingSubscriptionModel.findOneAndUpdate(
    { orgId: sharedOrgId },
    { plan: "starter", status: "active", provider: "internal" },
    { upsert: true },
  );

  const ownerAgents = await api("/api/voice/agents", { cookie: ownerSharedCookie });
  const sharedStarterId = (ownerAgents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!sharedStarterId) throw new Error("Shared organization did not create a scoped starter agent.");

  const invitation = await api("/api/organizations/current/invitations", {
    method: "POST",
    cookie: ownerSharedCookie,
    body: { email: `phase2-member-${suffix}@example.com`, role: "member" },
  });
  const acceptUrl = (invitation.data as { invitation?: { acceptUrl?: string } }).invitation?.acceptUrl;
  if (invitation.status !== 201 || !acceptUrl) throw new Error("Member invitation failed.");
  const token = acceptUrl.split("/").at(-1);
  if (!token) throw new Error("Invitation accept token was missing.");

  const accepted = await api("/api/organizations/invitations/accept", {
    method: "POST",
    cookie: member.cookie,
    body: { token },
  });
  if (accepted.status !== 204 || !accepted.cookie) throw new Error("Invitation acceptance failed.");
  const memberSharedCookie = accepted.cookie;

  const memberAgents = await api("/api/voice/agents", { cookie: memberSharedCookie });
  const memberVisibleIds = (memberAgents.data as { agents: { _id: string }[] }).agents.map(
    (agent) => agent._id,
  );
  if (!memberVisibleIds.includes(sharedStarterId)) {
    throw new Error("Organization member could not see shared organization resources.");
  }

  const forbiddenInvite = await api("/api/organizations/current/invitations", {
    method: "POST",
    cookie: memberSharedCookie,
    body: { email: `forbidden-${suffix}@example.com`, role: "member" },
  });
  if (forbiddenInvite.status !== 403) throw new Error("Member role bypassed invitation RBAC.");

  const memberCreatedAgent = await api("/api/voice/agents", {
    method: "POST",
    cookie: memberSharedCookie,
    body: { name: "Member-created shared agent" },
  });
  if (memberCreatedAgent.status !== 201) throw new Error("Member could not create a shared agent.");
  const sharedAgentId = (memberCreatedAgent.data as { agent: { _id: string } }).agent._id;

  const switched = await api(`/api/organizations/${owner.orgId}/switch`, {
    method: "POST",
    cookie: ownerSharedCookie,
  });
  if (switched.status !== 204 || !switched.cookie) throw new Error("Organization switch failed.");
  const defaultAgents = await api("/api/voice/agents", { cookie: switched.cookie });
  const defaultIds = (defaultAgents.data as { agents: { _id: string }[] }).agents.map(
    (agent) => agent._id,
  );
  if (defaultIds.includes(sharedStarterId) || defaultIds.includes(sharedAgentId)) {
    throw new Error("Resources leaked across organization boundaries.");
  }

  const organizations = await api("/api/organizations", { cookie: ownerSharedCookie });
  if ((organizations.data as { organizations: unknown[] }).organizations.length !== 2) {
    throw new Error("Owner organization list did not contain both workspaces.");
  }

  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "default organization provisioning",
        "organization creation and switching",
        "member invitation and acceptance",
        "role-based invitation restriction",
        "shared organization resource access",
        "cross-organization data isolation",
      ],
    }),
  );
} finally {
  await Promise.all([
    CallDetailRecordModel.deleteMany({ ownerId: { $in: orgIds } }),
    BillingSubscriptionModel.deleteMany({ orgId: { $in: orgIds } }),
    PhoneNumberModel.deleteMany({ ownerId: { $in: orgIds } }),
    ProviderIntegrationModel.deleteMany({ ownerId: { $in: orgIds } }),
    VoiceAgentModel.deleteMany({ ownerId: { $in: orgIds } }),
    OrganizationInvitationModel.deleteMany({ orgId: { $in: orgIds } }),
    OrganizationMemberModel.deleteMany({ orgId: { $in: orgIds } }),
    OrganizationModel.deleteMany({ _id: { $in: orgIds } }),
    UserModel.deleteMany({ _id: { $in: userIds } }),
  ]);
  await mongoose.disconnect();
}
