import type { AddressInfo } from "node:net";
import mongoose from "mongoose";

import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { ProviderIntegrationModel } from "../src/models/ProviderIntegration.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { completeCall } from "../src/services/callRecordService.js";
import { createCalendlySchedulingLink, listCalendlyEventTypes } from "../src/services/integrationService.js";

const suffix = Date.now();
let ownerId = "";
let cookie = "";
const providerRequests: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
  providerRequests.push(url);
  if (url === "https://api.calendly.com/users/me") {
    return Response.json({ resource: { name: "Smoke Calendar", uri: "https://api.calendly.com/users/one", current_organization: "https://api.calendly.com/organizations/one" } });
  }
  if (url.startsWith("https://api.calendly.com/event_types")) {
    return Response.json({ collection: [{ uri: "https://api.calendly.com/event_types/one", name: "Discovery call" }] });
  }
  if (url === "https://api.calendly.com/scheduling_links") {
    return Response.json({ resource: { booking_url: "https://calendly.com/d/one" } });
  }
  if (url.endsWith("/crm/v3/objects/contacts/search")) return Response.json({ results: [] });
  if (url.endsWith("/crm/v3/objects/contacts") && init?.method === "POST") return Response.json({ id: "contact-one" });
  if (url.endsWith("/crm/v3/objects/notes")) return Response.json({ id: "note-one" });
  if (url.startsWith("https://api.hubapi.com/")) return Response.json({ results: [] });
  if (url.startsWith("https://hooks.slack.com/")) return new Response("ok", { status: 200 });
  return new Response("Unexpected provider URL", { status: 500 });
};

await connectDatabase();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(path: string, input: { method?: string; body?: unknown } = {}) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: { ...(input.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get("set-cookie") ?? "" };
}

try {
  const registration = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Phase Seven Smoke", email: `phase7-${suffix}@example.com`, password: "phase-seven-smoke-password" },
  });
  cookie = registration.cookie.split(";")[0] ?? "";
  ownerId = (registration.data as { user: { id: string } }).user.id;
  const agents = await api("/api/voice/agents");
  const agentId = (agents.data as { agents: { _id: string }[] }).agents[0]?._id;
  if (!agentId) throw new Error("Starter agent missing.");

  for (const [provider, credential] of [
    ["hubspot", `pat-${suffix}`],
    ["calendly", `cal-${suffix}`],
    ["slack", "https://hooks.slack.com/services/test/smoke/secret"],
  ]) {
    const result = await api(`/api/integrations/${provider}`, { method: "PUT", body: { credential } });
    if (result.status !== 200) throw new Error(`${provider} connection failed: ${JSON.stringify(result.data)}`);
  }
  const integrations = await api("/api/integrations");
  const providers = (integrations.data as { providers: { id: string; connected: boolean }[] }).providers;
  if (!["hubspot", "calendly", "slack"].every((id) => providers.some((item) => item.id === id && item.connected))) {
    throw new Error("Connected providers were not listed.");
  }
  const saved = await ProviderIntegrationModel.find({ ownerId }).select("+secretEncrypted");
  if (saved.some((item) => item.secretEncrypted.includes(`-${suffix}`))) throw new Error("Provider credential was not encrypted.");

  const eventTypes = await listCalendlyEventTypes(ownerId);
  const link = await createCalendlySchedulingLink(ownerId, "https://api.calendly.com/event_types/one");
  if (!Array.isArray(eventTypes.collection) || !(link.resource as Record<string, unknown>)?.booking_url) {
    throw new Error("Calendly agent tools did not call the provider.");
  }

  const call = await CallDetailRecordModel.create({
    ownerId,
    orgId: ownerId,
    agentId,
    livekitRoomName: `phase7-${suffix}`,
    direction: "outbound",
    status: "active",
    callerNumber: "+15550001111",
    startedAt: new Date(Date.now() - 8000),
  });
  await completeCall(call.livekitRoomName);
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!providerRequests.some((url) => url.endsWith("/crm/v3/objects/notes")) || !providerRequests.some((url) => url.startsWith("https://hooks.slack.com/"))) {
    throw new Error("Post-call native integrations were not dispatched.");
  }

  const disconnected = await api("/api/integrations/slack", { method: "DELETE" });
  if (disconnected.status !== 204 || await ProviderIntegrationModel.exists({ ownerId, provider: "slack" })) {
    throw new Error("Native integration disconnect failed.");
  }

  console.log(JSON.stringify({
    passed: true,
    checks: ["HubSpot credential validation", "Calendly credential validation", "Slack webhook validation", "encrypted credential storage", "integration status API", "Calendly agent tools", "HubSpot post-call activity", "Slack post-call notification", "integration disconnect"],
  }));
} finally {
  globalThis.fetch = originalFetch;
  server.close();
  if (ownerId) {
    await Promise.all([
      ProviderIntegrationModel.deleteMany({ ownerId }),
      CallDetailRecordModel.deleteMany({ ownerId }),
      VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }),
      OrganizationModel.deleteOne({ _id: ownerId }),
      UserModel.deleteOne({ _id: ownerId }),
    ]);
  }
  await mongoose.disconnect();
}
