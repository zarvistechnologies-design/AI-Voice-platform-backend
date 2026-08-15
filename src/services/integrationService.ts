import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { DigitalBotAgentConnectionModel } from "../models/DigitalBotAgentConnection.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { listVobizOwnedNumbers, type VobizCredentials } from "./vobizService.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";
import { env } from "../config/env.js";

export const nativeProviders = ["hubspot", "calendly", "slack"] as const;
export type NativeProvider = (typeof nativeProviders)[number];
type PostCallProvider = "hubspot" | "slack";

const digitalbotRequiredPermissions = ["availability:read", "appointments:create"];

function digitalbotToolUrl(action: "check-availability" | "book-appointment") {
  return action === "check-availability"
    ? `${env.digitalbotWebhookBaseUrl}/api/availability`
    : `${env.digitalbotWebhookBaseUrl}/api/book-appointment`;
}

async function digitalbotFetch(
  path: string,
  token: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
) {
  try {
    return await integrationFetch(`${env.digitalbotApiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    }, timeoutMs);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(
        error.statusCode,
        error.message.replace(/^Provider rejected the credentials:\s*/i, ""),
      );
    }
    throw error;
  }
}

function digitalbotConnectionFromResponse(data: Record<string, unknown>) {
  const connection = data.connection && typeof data.connection === "object"
    ? data.connection as Record<string, unknown>
    : {};
  const workspace = connection.workspace && typeof connection.workspace === "object"
    ? connection.workspace as Record<string, unknown>
    : {};
  const branch = connection.branch && typeof connection.branch === "object"
    ? connection.branch as Record<string, unknown>
    : null;
  const permissions = Array.isArray(connection.permissions)
    ? connection.permissions.map((permission) => String(permission)).filter(Boolean)
    : [];
  const toolDefinitions = Array.isArray(connection.tools) ? connection.tools : [];
  const toolSchemaVersion = Number.isInteger(connection.toolSchemaVersion)
    ? Number(connection.toolSchemaVersion)
    : 0;
  return {
    connectionId: String(connection.id ?? ""),
    status: String(connection.status ?? "connected"),
    workspaceName: String(workspace.name ?? workspace.id ?? "DigitalBot workspace"),
    workspaceId: String(workspace.id ?? ""),
    branchName: branch ? String(branch.name ?? branch.id ?? "") : "",
    branchId: branch ? String(branch.id ?? "") : "",
    permissions,
    toolDefinitions,
    toolSchemaVersion,
    provider: String(connection.provider ?? "vozon"),
  };
}

type DigitalBotToolParameterDefinition = {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
};

type DigitalBotToolDefinition = {
  name: string;
  description: string;
  method: "POST";
  url: string;
  headers: Record<string, string>;
  timeoutSeconds: number;
  enabled: boolean;
  excludeSessionId: boolean;
  executeAfterMessage: boolean;
  runAfterCall: boolean;
  managedBy: "digitalbot";
  messages: string[];
  parameters: DigitalBotToolParameterDefinition[];
};

const fallbackDigitalBotToolDefinitions: DigitalBotToolDefinition[] = [
    {
      name: "check_doctor_availability",
      description: "Check available appointment slots for doctors in the connected DigitalBot clinic. Always use this before offering a time.",
      method: "POST" as const,
      url: digitalbotToolUrl("check-availability"),
      headers: {},
      timeoutSeconds: 12,
      enabled: true,
      excludeSessionId: false,
      executeAfterMessage: false,
      runAfterCall: false,
      managedBy: "digitalbot",
      messages: ["Let me check the doctor's availability."],
      parameters: [
        { name: "assignedPhoneNumber", type: "string" as const, description: "{{ToPhone}}", required: false },
        { name: "doctorId", type: "string" as const, description: "Doctor ID returned by a previous availability check, when known.", required: false },
        { name: "doctorName", type: "string" as const, description: "Doctor name when the ID is not known.", required: false },
        { name: "date", type: "string" as const, description: "Requested date in YYYY-MM-DD format.", required: true },
        { name: "specialization", type: "string" as const, description: "Doctor specialization, when the caller asks for one.", required: false },
      ],
    },
    {
      name: "book_appointment",
      description: "Create a confirmed appointment in DigitalBot after availability has been checked and the caller has confirmed.",
      method: "POST" as const,
      url: digitalbotToolUrl("book-appointment"),
      headers: {},
      timeoutSeconds: 15,
      enabled: true,
      excludeSessionId: false,
      executeAfterMessage: false,
      runAfterCall: false,
      managedBy: "digitalbot",
      messages: ["I am booking that appointment now."],
      parameters: [
        { name: "assignedPhoneNumber", type: "string" as const, description: "{{ToPhone}}", required: false },
        { name: "doctorId", type: "string" as const, description: "Doctor ID returned by check_doctor_availability, when known.", required: false },
        { name: "doctorName", type: "string" as const, description: "Doctor name when the ID is not known.", required: false },
        { name: "patientName", type: "string" as const, description: "Patient's full name.", required: true },
        { name: "patientPhone", type: "string" as const, description: "{{FromPhone}}", required: false },
        { name: "date", type: "string" as const, description: "Appointment date in YYYY-MM-DD format.", required: true },
        { name: "time", type: "string" as const, description: "An available appointment time returned by check_doctor_availability.", required: true },
        { name: "purpose", type: "string" as const, description: "Reason for the appointment.", required: false },
        { name: "location", type: "string" as const, description: "Patient location or address, when needed.", required: false },
        { name: "age", type: "number" as const, description: "Patient age in years, when known.", required: false },
      ],
    },
  ];

function validToolUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validatedRemoteToolDefinitions(value: unknown): DigitalBotToolDefinition[] | null {
  if (!Array.isArray(value) || value.length !== fallbackDigitalBotToolDefinitions.length) return null;
  const remoteByName = new Map(
    value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => [String(item.name ?? ""), item]),
  );

  const definitions: DigitalBotToolDefinition[] = [];
  for (const fallback of fallbackDigitalBotToolDefinitions) {
    const remote = remoteByName.get(fallback.name);
    if (!remote || remote.method !== "POST" || !validToolUrl(remote.url) || !Array.isArray(remote.parameters)) {
      return null;
    }
    const expectedParameters = new Map(fallback.parameters.map((parameter) => [parameter.name, parameter]));
    const remoteParameters = remote.parameters.filter(
      (parameter): parameter is Record<string, unknown> => Boolean(parameter) && typeof parameter === "object" && !Array.isArray(parameter),
    );
    if (remoteParameters.length !== expectedParameters.size) return null;
    for (const parameter of remoteParameters) {
      const expected = expectedParameters.get(String(parameter.name ?? ""));
      if (!expected || parameter.type !== expected.type || parameter.required !== expected.required) return null;
    }

    const headers = remote.headers && typeof remote.headers === "object" && !Array.isArray(remote.headers)
      ? Object.fromEntries(
          Object.entries(remote.headers as Record<string, unknown>)
            .map(([key, headerValue]) => [key.trim(), String(headerValue ?? "").trim()] as const)
            .filter(([key, headerValue]) => key && headerValue)
            .slice(0, 30),
        )
      : {};
    const messages = Array.isArray(remote.messages)
      ? remote.messages.map((message) => String(message ?? "").trim()).filter(Boolean).slice(0, 5)
      : fallback.messages;
    definitions.push({
      ...fallback,
      description: typeof remote.description === "string" ? remote.description.trim().slice(0, 500) : fallback.description,
      url: String(remote.url),
      headers,
      timeoutSeconds: Math.min(30, Math.max(1, Number(remote.timeoutSeconds) || fallback.timeoutSeconds)),
      enabled: true,
      excludeSessionId: false,
      executeAfterMessage: false,
      runAfterCall: false,
      managedBy: "digitalbot",
      messages,
      parameters: fallback.parameters.map((expected) => {
        const parameter = remoteParameters.find((item) => item.name === expected.name)!;
        return {
          ...expected,
          description: typeof parameter.description === "string"
            ? parameter.description.trim().slice(0, 500)
            : expected.description,
        };
      }),
    });
  }
  return definitions;
}

export function digitalbotToolDefinitions(remoteDefinitions?: unknown) {
  return validatedRemoteToolDefinitions(remoteDefinitions)
    ?? fallbackDigitalBotToolDefinitions.map((tool) => ({
      ...tool,
      headers: { ...tool.headers },
      messages: [...tool.messages],
      parameters: tool.parameters.map((parameter) => ({ ...parameter })),
    }));
}

const integrationRetrySeconds = [60, 300, 1800, 7200, 43200];
const integrationDeliveryLeaseMs = 2 * 60_000;
const integrationDeliveryConcurrency = 5;

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
    await invalidateDashboardCache(ownerId);
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

export async function connectVobiz(
  ownerId: string,
  credentials: VobizCredentials,
  options: { verifiedOwnedNumberCount?: number } = {},
) {
  const ownedNumberCount = options.verifiedOwnedNumberCount
    ?? (await listVobizOwnedNumbers(credentials, 1, 1)).total;
  const integration = await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider: "vobiz" },
    {
      ownerId,
      provider: "vobiz",
      accountId: credentials.authId,
      secretEncrypted: encryptSecret(credentials.authToken),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: { ownedNumberCount },
    },
    { new: true, upsert: true, runValidators: true },
  );
  await invalidateDashboardCache(ownerId);
  return integration;
}

export async function disconnectVobiz(ownerId: string) {
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "vobiz" });
  await invalidateDashboardCache(ownerId);
}

async function integrationFetch(url: string, init: RequestInit, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = (await response.json().catch(async () => ({ text: await response.text() }))) as Record<string, unknown>;
    if (!response.ok) {
      throw new HttpError(400, `Provider rejected the credentials: ${String(data.message ?? data.text ?? response.statusText)}`);
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new HttpError(
      502,
      timedOut
        ? "The connected service took too long to respond. Please try again."
        : "Vozon could not reach the connected service. Please try again in a moment.",
    );
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

export async function verifyDigitalBotToken(token: string) {
  const secret = token.trim();
  if (!/^db_conn_[A-Za-z0-9._~-]{16,}$/.test(secret)) {
    throw new HttpError(400, "Enter a valid DigitalBot connection key.");
  }
  const data = await digitalbotFetch("/api/v1/connector/me", secret);
  const connection = digitalbotConnectionFromResponse(data);
  const missing = digitalbotRequiredPermissions.filter((permission) => !connection.permissions.includes(permission));
  if (missing.length) {
    throw new HttpError(400, `DigitalBot connection is missing permissions: ${missing.join(", ")}.`);
  }
  if (connection.status && connection.status !== "active" && connection.status !== "connected") {
    throw new HttpError(400, "DigitalBot connection is not active.");
  }
  return connection;
}

export async function connectDigitalBotIntegration(
  ownerId: string,
  token: string,
  options: {
    agentId: string;
    agentName?: string;
    agentPhone?: string;
    agentTeam?: string;
    agentStatus?: string;
    agentLanguage?: string;
    displayName?: string;
  },
) {
  const secret = token.trim();
  const agentId = options.agentId.trim();
  if (!agentId) throw new HttpError(400, "Choose the Vozon agent for this DigitalBot connection.");
  const connection = await verifyDigitalBotToken(secret);
  const existingConnection = await DigitalBotAgentConnectionModel.findOne({
    "metadata.connectionId": connection.connectionId,
    $or: [
      { ownerId: { $ne: ownerId } },
      { targetAgentId: { $ne: agentId } },
    ],
  }).lean();
  if (existingConnection) {
    throw new HttpError(409, "This DigitalBot key is already connected to another Vozon agent.");
  }
  const assignedNumbers = await PhoneNumberModel.find({
    ownerId,
    agentId,
    status: "Ready",
    lifecycle: "active",
  }).select("_id number").limit(2).lean();
  let phoneBindingStatus: "bound" | "pending_phone_assignment" | "multiple_phone_numbers" = "pending_phone_assignment";
  let externalPhoneNumberId = "";
  let externalPhoneNumber = "";
  if (assignedNumbers.length === 1) {
    externalPhoneNumberId = String(assignedNumbers[0]._id);
    externalPhoneNumber = assignedNumbers[0].number;
    phoneBindingStatus = "bound";
  } else if (assignedNumbers.length > 1) {
    phoneBindingStatus = "multiple_phone_numbers";
  } else {
    const agentPhone = options.agentPhone?.trim() || "";
    if (/^\+[1-9]\d{7,14}$/.test(agentPhone)) {
      externalPhoneNumber = agentPhone;
      phoneBindingStatus = "bound";
    }
  }
  await digitalbotFetch("/api/v1/connector/bind", secret, {
    method: "POST",
    body: JSON.stringify({
      externalAgentId: agentId,
      externalAgentName: options.agentName?.trim() || "",
      externalPhoneNumberId: externalPhoneNumberId || null,
      externalPhoneNumber: externalPhoneNumber || null,
      externalAgentMetadata: {
        team: options.agentTeam?.trim() || "",
        status: options.agentStatus?.trim() || "",
        language: options.agentLanguage?.trim() || "",
      },
    }),
  });
  const integration = await DigitalBotAgentConnectionModel.findOneAndUpdate(
    { ownerId, targetAgentId: agentId },
    {
      ownerId,
      displayName: options.displayName?.trim() || options.agentName?.trim() || connection.workspaceName,
      targetAgentId: agentId,
      targetAgentName: options.agentName?.trim() || "",
      accountId: connection.workspaceName,
      secretEncrypted: encryptSecret(secret),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: {
        connectionId: connection.connectionId,
        workspaceId: connection.workspaceId,
        workspaceName: connection.workspaceName,
        branchId: connection.branchId,
        branchName: connection.branchName,
        permissions: connection.permissions,
        toolDefinitions: connection.toolDefinitions,
        toolSchemaVersion: connection.toolSchemaVersion,
        tokenPrefix: secret.slice(0, 14),
        phoneBindingStatus,
        externalPhoneNumberId,
        externalPhoneNumber,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
  await invalidateDashboardCache(ownerId);
  return integration;
}

export async function verifyDigitalBotIntegration(ownerId: string, agentId: string) {
  const targetAgentId = agentId.trim();
  if (!targetAgentId) throw new HttpError(400, "Choose the Vozon agent for this DigitalBot connection.");
  let integration = await DigitalBotAgentConnectionModel.findOne({
    ownerId,
    targetAgentId,
  }).select("+secretEncrypted");
  integration ??= await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "digitalbot",
    targetAgentId,
  }).select("+secretEncrypted");
  if (!integration) throw new HttpError(404, "Connect DigitalBot first.");
  try {
    const connection = await verifyDigitalBotToken(decryptSecret(integration.secretEncrypted));
    integration.accountId = connection.workspaceName;
    integration.status = "connected";
    integration.lastVerifiedAt = new Date();
    integration.metadata = {
      ...(integration.metadata as Record<string, unknown> ?? {}),
      connectionId: connection.connectionId,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      branchId: connection.branchId,
      branchName: connection.branchName,
      permissions: connection.permissions,
      toolDefinitions: connection.toolDefinitions,
      toolSchemaVersion: connection.toolSchemaVersion,
    };
    await integration.save();
    await invalidateDashboardCache(ownerId);
    return integration;
  } catch (error) {
    const integrationId = (integration as { _id: unknown })._id;
    await Promise.all([
      DigitalBotAgentConnectionModel.updateOne({ _id: integrationId, ownerId }, { status: "error" }),
      ProviderIntegrationModel.updateOne({ _id: integrationId, ownerId, provider: "digitalbot" }, { status: "error" }),
    ]);
    await invalidateDashboardCache(ownerId);
    throw error;
  }
}

export async function disconnectDigitalBotIntegration(ownerId: string, agentId: string) {
  const targetAgentId = agentId.trim();
  if (!targetAgentId) throw new HttpError(400, "Choose the Vozon agent to disconnect from DigitalBot.");
  const modernIntegrations = [
    await DigitalBotAgentConnectionModel.findOne({ ownerId, targetAgentId }).select("+secretEncrypted"),
  ];
  const legacyIntegrations = [
    await ProviderIntegrationModel.findOne({ ownerId, provider: "digitalbot", targetAgentId }).select("+secretEncrypted"),
  ];
  const releasedTokens = new Set<string>();
  const externalReleaseErrors: string[] = [];

  for (const integration of [...modernIntegrations, ...legacyIntegrations]) {
    if (!integration) continue;
    let secret: string;
    try {
      secret = decryptSecret(integration.secretEncrypted);
    } catch (error) {
      externalReleaseErrors.push("The saved DigitalBot key could not be decrypted.");
      console.error(JSON.stringify({
        event: "digitalbot-unbind-skipped",
        ownerId,
        targetAgentId,
        error: error instanceof Error ? error.message : String(error),
      }));
      continue;
    }
    if (releasedTokens.has(secret)) continue;
    releasedTokens.add(secret);
    try {
      await digitalbotFetch("/api/v1/connector/unbind", secret, {
        method: "POST",
        body: JSON.stringify({}),
      }, 5_000);
    } catch (error) {
      externalReleaseErrors.push(error instanceof Error ? error.message : String(error));
      console.error(JSON.stringify({
        event: "digitalbot-unbind-failed",
        ownerId,
        targetAgentId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  await DigitalBotAgentConnectionModel.deleteOne({ ownerId, targetAgentId });
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "digitalbot", targetAgentId });
  await invalidateDashboardCache(ownerId);
  return {
    externalReleaseSucceeded: externalReleaseErrors.length === 0,
    externalReleaseErrors,
  };
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
  const structuredOutput = call.structuredOutput && typeof call.structuredOutput === "object"
    ? call.structuredOutput as Record<string, unknown>
    : {};
  const outcome = String(structuredOutput.outcome ?? structuredOutput.disposition ?? "").trim();
  const phone = String(call.callerNumber || call.calledNumber || "").trim();
  const response = await fetch(credential, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [
        `Vozon call ${String(call.status)}`,
        `Direction: ${String(call.direction)}`,
        `Duration: ${String(call.durationSeconds ?? 0)} seconds`,
        ...(phone ? [`Phone: ${phone}`] : []),
        ...(outcome ? [`Outcome: ${outcome}`] : []),
        `Call ID: ${String(call._id ?? call.id ?? "")}`,
      ].join("\n"),
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
  const structuredOutput = call.structuredOutput && typeof call.structuredOutput === "object"
    ? call.structuredOutput as Record<string, unknown>
    : {};
  const details = Object.entries(structuredOutput)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 20)
    .map(([key, value]) => `${key}: ${String(value)}`);
  const noteBody = [
    `Vozon call ${String(call.status)}`,
    `Direction: ${String(call.direction)}`,
    `Duration: ${String(call.durationSeconds ?? 0)} seconds`,
    `Call ID: ${String(call._id ?? call.id ?? "")}`,
    ...details,
  ].join("<br>");
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
  const attempts = [
    ...(connected.includes("slack") ? [{ provider: "slack", task: notifySlack(ownerId, call) }] : []),
    ...(connected.includes("hubspot") ? [{ provider: "hubspot", task: logHubSpotCall(ownerId, call) }] : []),
  ];
  const results = await Promise.allSettled(attempts.map((attempt) => attempt.task));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const failure = {
      provider: attempts[index].provider,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
    console.error(JSON.stringify({
      event: "post-call-integration-delivery-failed",
      callId: String(call._id ?? call.id ?? ""),
      ownerId,
      ...failure,
    }));
    return [failure];
  });
  return {
    attempted: attempts.length,
    succeeded: attempts.length - failures.length,
    failures,
  };
}

export async function stagePostCallIntegrations(
  ownerId: string,
  call: Record<string, unknown>,
) {
  const providers = await ProviderIntegrationModel.find({
    ownerId,
    status: "connected",
    provider: { $in: ["slack", "hubspot"] },
  }).distinct("provider") as PostCallProvider[];
  const callId = String(call._id ?? call.id ?? "");
  if (!callId) throw new Error("Cannot queue integrations without a call ID.");
  return Promise.all(providers.map(async (provider) => {
    const eventId = `call.ended:${callId}`;
    const staged = await IntegrationDeliveryModel.findOneAndUpdate(
      { ownerId, provider, eventId, status: "staged" },
      { $set: { payload: call, event: "call.ended" } },
      { new: true, runValidators: true },
    );
    if (staged) return staged;
    try {
      return await IntegrationDeliveryModel.findOneAndUpdate(
        { ownerId, provider, eventId },
        {
          $setOnInsert: {
            ownerId,
            provider,
            eventId,
            event: "call.ended",
            payload: call,
            status: "staged",
          },
        },
        { new: true, upsert: true, runValidators: true },
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
      const winner = await IntegrationDeliveryModel.findOne({ ownerId, provider, eventId });
      if (!winner) throw error;
      return winner;
    }
  }));
}

export async function activateStagedIntegrationDeliveries(
  deliveryIds: string[],
  options: { session?: ClientSession } = {},
) {
  if (!deliveryIds.length) return;
  await IntegrationDeliveryModel.updateMany(
    { _id: { $in: deliveryIds }, status: "staged" },
    { $set: { status: "pending", nextAttemptAt: new Date() } },
    options.session ? { session: options.session } : {},
  );
}

export async function deliverIntegration(deliveryId: string) {
  const now = new Date();
  const deliveryToken = randomUUID();
  const delivery = await IntegrationDeliveryModel.findOneAndUpdate(
    {
      _id: deliveryId,
      $or: [
        {
          status: { $in: ["pending", "retrying"] },
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: now } },
          ],
        },
        { status: "processing", deliveryLeaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        deliveryToken,
        deliveryLeaseUntil: new Date(now.getTime() + integrationDeliveryLeaseMs),
      },
    },
    { new: true },
  ).select("+deliveryToken +deliveryLeaseUntil");
  if (!delivery) return IntegrationDeliveryModel.findById(deliveryId);

  let errorMessage = "";
  try {
    if (delivery.provider === "slack") await notifySlack(delivery.ownerId, delivery.payload as Record<string, unknown>);
    else await logHubSpotCall(delivery.ownerId, delivery.payload as Record<string, unknown>);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const attemptNumber = delivery.attempts + 1;
  const retryDelaySeconds = errorMessage ? integrationRetrySeconds[attemptNumber - 1] : undefined;
  const completedAt = new Date();
  return IntegrationDeliveryModel.findOneAndUpdate(
    { _id: delivery._id, status: "processing", deliveryToken },
    {
      $set: {
        status: errorMessage ? (retryDelaySeconds ? "retrying" : "failed") : "delivered",
        deliveryToken: "",
        errorMessage,
        ...(errorMessage
          ? retryDelaySeconds
            ? { nextAttemptAt: new Date(completedAt.getTime() + retryDelaySeconds * 1000) }
            : {}
          : { deliveredAt: completedAt }),
      },
      $inc: { attempts: 1 },
      $unset: {
        deliveryLeaseUntil: "",
        ...(!retryDelaySeconds ? { nextAttemptAt: "" } : {}),
      },
    },
    { new: true },
  );
}

export async function processIntegrationRetries() {
  const now = new Date();
  const deliveries = await IntegrationDeliveryModel.find({
    $or: [
      {
        status: { $in: ["pending", "retrying"] },
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: now } },
        ],
      },
      { status: "processing", deliveryLeaseUntil: { $lte: now } },
    ],
  })
    .select("_id")
    .sort({ nextAttemptAt: 1, deliveryLeaseUntil: 1 })
    .limit(100)
    .lean();
  for (let index = 0; index < deliveries.length; index += integrationDeliveryConcurrency) {
    await Promise.allSettled(
      deliveries.slice(index, index + integrationDeliveryConcurrency)
        .map((delivery) => deliverIntegration(String(delivery._id))),
    );
  }
}
