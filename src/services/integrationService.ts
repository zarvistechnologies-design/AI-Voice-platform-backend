import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { listVobizOwnedNumbers, type VobizCredentials } from "./vobizService.js";

export const nativeProviders = ["hubspot", "calendly", "slack"] as const;
export type NativeProvider = (typeof nativeProviders)[number];

export async function getVobizIntegration(ownerId: string) {
  return ProviderIntegrationModel.findOne({ ownerId, provider: "vobiz" });
}

export async function getVobizCredentials(ownerId: string): Promise<VobizCredentials> {
  const integration = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "vobiz",
  }).select("+secretEncrypted");
  if (!integration) {
    throw new HttpError(409, "Connect your Vobiz account before managing phone numbers.");
  }
  let authToken = "";
  try {
    authToken = decryptSecret(integration.secretEncrypted);
  } catch {
    await ProviderIntegrationModel.updateOne(
      { _id: integration._id },
      { status: "error" },
    );
    throw new HttpError(
      409,
      "Your saved Vobiz credentials can no longer be decrypted. Restore the original INTEGRATION_ENCRYPTION_KEY or disconnect and reconnect your Vobiz account.",
    );
  }
  return {
    authId: integration.accountId,
    authToken,
  };
}

export async function connectVobiz(ownerId: string, credentials: VobizCredentials) {
  const numbers = await listVobizOwnedNumbers(credentials, 1, 1);
  return ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider: "vobiz" },
    {
      ownerId,
      provider: "vobiz",
      accountId: credentials.authId,
      secretEncrypted: encryptSecret(credentials.authToken),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: { ownedNumberCount: numbers.total },
    },
    { new: true, upsert: true, runValidators: true },
  );
}

export async function disconnectVobiz(ownerId: string) {
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "vobiz" });
}

async function integrationFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = (await response.json().catch(async () => ({ text: await response.text() }))) as Record<string, unknown>;
    if (!response.ok) {
      throw new HttpError(400, `Provider rejected the credentials: ${String(data.message ?? data.text ?? response.statusText)}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function connectNativeIntegration(ownerId: string, provider: NativeProvider, credential: string) {
  const secret = credential.trim();
  if (!secret) throw new HttpError(400, "Enter the provider credential.");
  let accountId: string = provider;
  let metadata: Record<string, unknown> = {};

  if (provider === "hubspot") {
    const result = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    accountId = "HubSpot private app";
    metadata = { verifiedObjectCount: Array.isArray(result.results) ? result.results.length : 0 };
  } else if (provider === "calendly") {
    const result = await integrationFetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const resource = (result.resource ?? {}) as Record<string, unknown>;
    accountId = String(resource.name ?? resource.email ?? "Calendly account");
    metadata = { uri: resource.uri ?? "", organization: resource.current_organization ?? "" };
  } else {
    let url: URL;
    try {
      url = new URL(secret);
    } catch {
      throw new HttpError(400, "Enter a valid Slack incoming webhook URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") {
      throw new HttpError(400, "Slack integration requires an https://hooks.slack.com incoming webhook URL.");
    }
    const response = await fetch(secret, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "AI Voice Platform connected successfully." }),
    });
    if (!response.ok) throw new HttpError(400, "Slack rejected the incoming webhook URL.");
    accountId = "Slack incoming webhook";
  }

  return ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider },
    {
      ownerId,
      provider,
      accountId,
      secretEncrypted: encryptSecret(secret),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata,
    },
    { new: true, upsert: true, runValidators: true },
  );
}

export async function disconnectNativeIntegration(ownerId: string, provider: NativeProvider) {
  await ProviderIntegrationModel.deleteOne({ ownerId, provider });
}

async function nativeCredential(ownerId: string, provider: NativeProvider) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId, provider, status: "connected" }).select("+secretEncrypted");
  if (!integration) throw new HttpError(409, `Connect ${provider} before using this action.`);
  return { integration, credential: decryptSecret(integration.secretEncrypted) };
}

export async function listCalendlyEventTypes(ownerId: string) {
  const { integration, credential } = await nativeCredential(ownerId, "calendly");
  const organization = String((integration.metadata as Record<string, unknown>)?.organization ?? "");
  if (!organization) throw new HttpError(409, "Reconnect Calendly to refresh organization details.");
  return integrationFetch(`https://api.calendly.com/event_types?organization=${encodeURIComponent(organization)}&active=true`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

export async function createCalendlySchedulingLink(ownerId: string, ownerUri: string) {
  const { credential } = await nativeCredential(ownerId, "calendly");
  return integrationFetch("https://api.calendly.com/scheduling_links", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_event_count: 1, owner: ownerUri, owner_type: "EventType" }),
  });
}

async function notifySlack(ownerId: string, call: Record<string, unknown>) {
  const { credential } = await nativeCredential(ownerId, "slack");
  const response = await fetch(credential, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `Call ${String(call.status)}: ${String(call.direction)} conversation lasted ${String(call.durationSeconds ?? 0)} seconds.`,
    }),
  });
  if (!response.ok) throw new Error(`Slack notification failed with HTTP ${response.status}.`);
}

async function logHubSpotCall(ownerId: string, call: Record<string, unknown>) {
  const { credential } = await nativeCredential(ownerId, "hubspot");
  const phone = String(call.callerNumber || call.calledNumber || "");
  let contactId = "";
  if (phone) {
    const search = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }], limit: 1 }),
    });
    contactId = String(((search.results as Record<string, unknown>[] | undefined)?.[0]?.id) ?? "");
    if (!contactId) {
      const contact = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { phone, lastname: "Voice caller" } }),
      });
      contactId = String(contact.id ?? "");
    }
  }
  const noteBody = `AI Voice Platform call ${String(call.status)}. Direction: ${String(call.direction)}. Duration: ${String(call.durationSeconds ?? 0)} seconds.`;
  await integrationFetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody },
      ...(contactId ? { associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] } : {}),
    }),
  });
}

export async function runPostCallIntegrations(ownerId: string, call: Record<string, unknown>) {
  const connected = await ProviderIntegrationModel.find({ ownerId, status: "connected", provider: { $in: ["slack", "hubspot"] } }).distinct("provider");
  await Promise.allSettled([
    ...(connected.includes("slack") ? [notifySlack(ownerId, call)] : []),
    ...(connected.includes("hubspot") ? [logHubSpotCall(ownerId, call)] : []),
  ]);
}
