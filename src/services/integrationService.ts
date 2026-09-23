import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { DigitalBotAgentConnectionModel } from "../models/DigitalBotAgentConnection.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { NativeAppointmentModel } from "../models/NativeAppointment.js";
import { NativeWorkflowRecordModel } from "../models/NativeWorkflowRecord.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { listVobizOwnedNumbers, type VobizCredentials } from "./vobizService.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";
import { env } from "../config/env.js";
import { productNameForOrganization } from "./whiteLabelService.js";
import { appendGoogleSheetRecords, appendGoogleSheetRows, type GoogleSheetColumn } from "./googleWorkspaceService.js";

export const nativeProviders = ["hubspot", "calendly", "slack"] as const;
export type NativeProvider = (typeof nativeProviders)[number];
type PostCallProvider = "hubspot" | "slack" | "google_sheets";

const fallbackDigitalBotRequiredPermissions = ["availability:read", "appointments:create"];

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
  productName = "Vozon",
) {
  try {
    return await integrationFetch(`${env.digitalbotApiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    }, timeoutMs, productName);
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
      messages: [],
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
      messages: [],
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
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;

  const definitions: DigitalBotToolDefinition[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const remote = item as Record<string, unknown>;
    const name = typeof remote.name === "string" ? remote.name.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name) || names.has(name)) return null;
    names.add(name);
    if (remote.method !== "POST" || !validToolUrl(remote.url) || !Array.isArray(remote.parameters)) {
      return null;
    }
    const remoteParameters = remote.parameters.filter(
      (parameter): parameter is Record<string, unknown> => Boolean(parameter) && typeof parameter === "object" && !Array.isArray(parameter),
    );
    if (remoteParameters.length > 50) return null;
    const parameterNames = new Set<string>();
    const parameters: DigitalBotToolParameterDefinition[] = [];
    for (const parameter of remoteParameters) {
      const parameterName = typeof parameter.name === "string" ? parameter.name.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameterName) || parameterNames.has(parameterName)) return null;
      parameterNames.add(parameterName);
      if (!["string", "number", "boolean", "object"].includes(String(parameter.type))) return null;
      parameters.push({
        name: parameterName,
        type: parameter.type as DigitalBotToolParameterDefinition["type"],
        description: typeof parameter.description === "string"
          ? parameter.description.trim().slice(0, 500)
          : "",
        required: parameter.required === true,
      });
    }

    const headers = remote.headers && typeof remote.headers === "object" && !Array.isArray(remote.headers)
      ? Object.fromEntries(
          Object.entries(remote.headers as Record<string, unknown>)
            .map(([key, headerValue]) => [key.trim(), String(headerValue ?? "").trim()] as const)
            .filter(([key, headerValue]) => key && headerValue)
            .slice(0, 30),
        )
      : {};
    definitions.push({
      name,
      description: typeof remote.description === "string"
        ? remote.description.trim().slice(0, 500)
        : `DigitalBot ${name} tool.`,
      method: "POST",
      url: String(remote.url),
      headers,
      timeoutSeconds: Math.min(30, Math.max(1, Number(remote.timeoutSeconds) || 15)),
      enabled: true,
      excludeSessionId: false,
      executeAfterMessage: false,
      runAfterCall: false,
      managedBy: "digitalbot",
      messages: [],
      parameters,
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

async function integrationFetch(url: string, init: RequestInit, timeoutMs = 12_000, productName = "Vozon") {
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
        : `${productName} could not reach the connected service. Please try again in a moment.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function connectNativeIntegration(ownerId: string, provider: NativeProvider, credential: string) {
  const secret = credential.trim();
  if (!secret) throw new HttpError(400, "Enter the provider credential.");
  const productName = await productNameForOrganization(ownerId);
  let accountId: string = provider;
  let metadata: Record<string, unknown> = {};

  if (provider === "hubspot") {
    const result = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
      headers: { Authorization: `Bearer ${secret}` },
    }, 12_000, productName);
    accountId = "HubSpot private app";
    metadata = { verifiedObjectCount: Array.isArray(result.results) ? result.results.length : 0 };
  } else if (provider === "calendly") {
    const result = await integrationFetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${secret}` },
    }, 12_000, productName);
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
      body: JSON.stringify({ text: `${productName} connected successfully.` }),
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

export async function verifyDigitalBotToken(token: string, productName = "Vozon") {
  const secret = token.trim();
  if (!/^db_conn_[A-Za-z0-9._~-]{16,}$/.test(secret)) {
    throw new HttpError(400, "Enter a valid DigitalBot connection key.");
  }
  const data = await digitalbotFetch("/api/v1/connector/me", secret, {}, 30_000, productName);
  const connection = digitalbotConnectionFromResponse(data);
  const toolNames = validatedRemoteToolDefinitions(connection.toolDefinitions)
    ?.map((tool) => tool.name) ?? [];
  const usesFallbackDoctorTools = toolNames.length === 0
    || toolNames.some((name) => name === "check_doctor_availability" || name === "book_appointment");
  const missing = usesFallbackDoctorTools
    ? fallbackDigitalBotRequiredPermissions.filter((permission) => !connection.permissions.includes(permission))
    : [];
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
  const productName = await productNameForOrganization(ownerId);
  const secret = token.trim();
  const agentId = options.agentId.trim();
  if (!agentId) throw new HttpError(400, `Choose the ${productName} agent for this DigitalBot connection.`);
  const connection = await verifyDigitalBotToken(secret, productName);
  const existingConnection = await DigitalBotAgentConnectionModel.findOne({
    "metadata.connectionId": connection.connectionId,
    $or: [
      { ownerId: { $ne: ownerId } },
      { targetAgentId: { $ne: agentId } },
    ],
  }).lean();
  if (existingConnection) {
    throw new HttpError(409, `This DigitalBot key is already connected to another ${productName} agent.`);
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
  }, 30_000, productName);
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
  const productName = await productNameForOrganization(ownerId);
  const targetAgentId = agentId.trim();
  if (!targetAgentId) throw new HttpError(400, `Choose the ${productName} agent for this DigitalBot connection.`);
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
    const connection = await verifyDigitalBotToken(decryptSecret(integration.secretEncrypted), productName);
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
  const productName = await productNameForOrganization(ownerId);
  const targetAgentId = agentId.trim();
  if (!targetAgentId) throw new HttpError(400, `Choose the ${productName} agent to disconnect from DigitalBot.`);
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
      }, 5_000, productName);
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
  const productName = await productNameForOrganization(ownerId);
  const { integration, credential } = await nativeCredential(ownerId, "calendly");
  const organization = String((integration.metadata as Record<string, unknown>)?.organization ?? "");
  if (!organization) throw new HttpError(409, "Reconnect Calendly to refresh organization details.");
  return integrationFetch(`https://api.calendly.com/event_types?organization=${encodeURIComponent(organization)}&active=true`, {
    headers: { Authorization: `Bearer ${credential}` },
  }, 12_000, productName);
}

export async function createCalendlySchedulingLink(ownerId: string, ownerUri: string) {
  const productName = await productNameForOrganization(ownerId);
  const { credential } = await nativeCredential(ownerId, "calendly");
  return integrationFetch("https://api.calendly.com/scheduling_links", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_event_count: 1, owner: ownerUri, owner_type: "EventType" }),
  }, 12_000, productName);
}

async function notifySlack(ownerId: string, call: Record<string, unknown>) {
  const productName = await productNameForOrganization(ownerId);
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
        `${productName} call ${String(call.status)}`,
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
  const productName = await productNameForOrganization(ownerId);
  const { credential } = await nativeCredential(ownerId, "hubspot");
  const phone = String(call.callerNumber || call.calledNumber || "");
  let contactId = "";
  if (phone) {
    const search = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }], limit: 1 }),
    }, 12_000, productName);
    contactId = String(((search.results as Record<string, unknown>[] | undefined)?.[0]?.id) ?? "");
    if (!contactId) {
      const contact = await integrationFetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { phone, lastname: "Voice caller" } }),
      }, 12_000, productName);
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
    `${productName} call ${String(call.status)}`,
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
  }, 12_000, productName);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstText(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (["string", "number", "boolean"].includes(typeof value)) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function isoDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function fieldLabel(key: string) {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function scalarDetails(source: Record<string, unknown>, excluded: Set<string>) {
  return Object.entries(source)
    .filter(([key, value]) => !excluded.has(key) && ["string", "number", "boolean"].includes(typeof value) && String(value).trim())
    .slice(0, 15)
    .map(([key, value]) => `${fieldLabel(key)}: ${String(value).trim()}`);
}

const googleSheetCoreColumns: GoogleSheetColumn[] = [
  { key: "timestamp", label: "Timestamp" },
  { key: "caller_name", label: "Caller Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "outcome", label: "Outcome" },
];

const googleSheetServiceColumns: GoogleSheetColumn[] = [
  { key: "services", label: "Services" },
  { key: "service_status", label: "Status" },
  { key: "details", label: "Details" },
];

const googleSheetCallIdColumn: GoogleSheetColumn = { key: "call_id", label: "Call ID" };
const googleSheetReservedKeys = new Set([
  ...googleSheetCoreColumns,
  ...googleSheetServiceColumns,
  googleSheetCallIdColumn,
].map((column) => column.key));
const googleSheetInternalServiceKeys = new Set([
  "service", "service_reference", "scheduled_for", "service_summary", "details",
]);
const googleSheetTransientServiceKeys = [
  "service", "service_reference", "scheduled_for", "service_summary",
] as const;
const googleSheetIdentityAliases = new Set([
  "caller_name", "customer_name", "patient_name", "guest_name", "contact_name", "lead_name",
  "full_name", "name",
  "phone", "contact_phone", "customer_phone", "patient_phone", "caller_phone",
  "email", "customer_email", "caller_email", "outcome", "disposition",
]);
const googleSheetSystemKeys = new Set([
  "id", "owner_id", "agent_id", "call_id", "created_at", "updated_at", "__v", "data",
  "kind", "status", "reference", "contact_name", "contact_phone", "summary", "scheduled_for_text",
  "appointment_type", "booking_reference", "patient_name", "patient_phone", "start_at",
]);

function googleSheetKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

function googleSheetValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  try {
    return JSON.stringify(value).slice(0, 5000);
  } catch {
    return String(value).slice(0, 5000);
  }
}

function copyGoogleSheetFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  excluded: Set<string>,
) {
  for (const [rawKey, value] of Object.entries(source)) {
    const key = googleSheetKey(rawKey);
    if (!key || excluded.has(key) || googleSheetReservedKeys.has(key) || googleSheetInternalServiceKeys.has(key)) continue;
    const normalized = googleSheetValue(value);
    if (normalized !== "") target[key] = normalized;
  }
}

export function googleSheetCallRecord(
  call: Record<string, unknown>,
  workflowValue: Record<string, unknown> | null = null,
  appointmentValue: Record<string, unknown> | null = null,
) {
  const workflow = objectValue(workflowValue);
  const appointment = objectValue(appointmentValue);
  const structuredOutput = objectValue(call.structuredOutput);
  const campaignLead = objectValue(call.campaignLead);
  const campaignLeadCustomFields = objectValue(campaignLead.customFields);
  const workflowData = objectValue(workflow.data);
  const workflowStatus = firstText(workflow, ["status"]);
  const appointmentStatus = firstText(appointment, ["status"]);
  const serviceStatus = workflowStatus || appointmentStatus || firstText(call, ["status"]);
  const structuredOutcome = firstText(structuredOutput, ["outcome", "disposition"]);
  const serviceKey = firstText(workflow, ["kind"])
    || firstText(appointment, ["appointmentType"])
    || "call_result";
  const service = fieldLabel(serviceKey);
  const serviceReference = firstText(workflow, ["reference"])
    || firstText(appointment, ["bookingReference"]);
  const scheduledFor = firstText(workflow, ["scheduledForText"])
    || (appointment.startAt ? isoDate(appointment.startAt) : "");
  const serviceSummary = firstText(workflow, ["summary"])
    || firstText(appointment, ["notes"]);
  const serviceDetailParts = [
    ...(serviceReference ? [`Reference: ${serviceReference}`] : []),
    ...(scheduledFor ? [`Scheduled for: ${scheduledFor}`] : []),
    ...(serviceSummary ? [serviceSummary] : []),
    ...scalarDetails(workflowData, googleSheetIdentityAliases),
  ];
  const record: Record<string, unknown> = {
    timestamp: isoDate(workflow.createdAt ?? appointment.createdAt ?? call.endedAt ?? call.createdAt),
    caller_name: firstText(workflow, ["contactName"])
      || firstText(appointment, ["patientName"])
      || firstText(structuredOutput, [
        "caller_name", "customer_name", "patient_name", "guest_name", "contact_name", "lead_name",
        "full_name", "name",
      ])
      || firstText(campaignLead, ["name"]),
    phone: firstText(workflow, ["contactPhone"])
      || firstText(appointment, ["patientPhone"])
      || (call.direction === "outbound"
        ? firstText(call, ["calledNumber", "callerNumber"])
        : firstText(call, ["callerNumber", "calledNumber"]))
      || firstText(campaignLead, ["phone"]),
    email: firstText(workflowData, ["email", "customer_email", "caller_email"])
      || firstText(structuredOutput, ["email", "customer_email", "caller_email"])
      || firstText(campaignLead, ["email"]),
    outcome: structuredOutcome || serviceStatus,
    service,
    service_status: serviceStatus,
    service_reference: serviceReference,
    scheduled_for: scheduledFor,
    service_summary: serviceSummary,
    details: serviceDetailParts.length ? `${service}: ${serviceDetailParts.join("; ")}` : "",
    call_id: String(call._id ?? call.id ?? "").trim(),
  };

  copyGoogleSheetFields(record, structuredOutput, googleSheetIdentityAliases);
  copyGoogleSheetFields(record, workflowData, googleSheetIdentityAliases);
  copyGoogleSheetFields(record, campaignLeadCustomFields, googleSheetIdentityAliases);
  copyGoogleSheetFields(record, appointment, googleSheetSystemKeys);
  return record;
}

export function googleSheetCallRecords(
  call: Record<string, unknown>,
  workflows: Record<string, unknown>[],
  appointments: Record<string, unknown>[],
) {
  const outcomes = [
    ...workflows.map((workflow) => ({ workflow, appointment: null, time: recordTime(workflow) })),
    ...appointments.map((appointment) => ({ workflow: null, appointment, time: recordTime(appointment) })),
  ].sort((left, right) => left.time - right.time);
  if (!outcomes.length) return [googleSheetCallRecord(call)];
  const serviceRecords = outcomes.map(({ workflow, appointment }) => googleSheetCallRecord(call, workflow, appointment));
  const merged = googleSheetCallRecord(call);
  merged.timestamp = isoDate(call.endedAt ?? call.createdAt ?? serviceRecords[0]?.timestamp);

  const uniqueText = (key: string) => [...new Set(
    serviceRecords.map((record) => String(record[key] ?? "").trim()).filter(Boolean),
  )].join(" | ");
  merged.services = uniqueText("service") || "Call Result";
  merged.service_status = uniqueText("service_status") || String(call.status ?? "").trim();
  merged.details = uniqueText("details");

  const structuredOutput = objectValue(call.structuredOutput);
  if (!firstText(structuredOutput, ["outcome", "disposition"])) {
    merged.outcome = String(serviceRecords[0]?.service_status ?? call.status ?? "").trim();
  }
  for (const record of serviceRecords) {
    for (const key of ["caller_name", "phone", "email"] as const) {
      if (!String(merged[key] ?? "").trim() && String(record[key] ?? "").trim()) merged[key] = record[key];
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        googleSheetReservedKeys.has(key)
        || googleSheetInternalServiceKeys.has(key)
        || googleSheetCoreColumns.some((column) => column.key === key)
        || key === "call_id"
        || value === ""
      ) continue;
      const current = String(merged[key] ?? "").trim();
      const incoming = String(value ?? "").trim();
      if (!current) merged[key] = value;
      else if (incoming && !current.split(" | ").includes(incoming)) merged[key] = `${current} | ${incoming}`;
    }
  }
  for (const key of googleSheetTransientServiceKeys) delete merged[key];
  return [merged];
}

export function googleSheetExportColumns(
  analysisFields: Array<{ key?: unknown; label?: unknown }>,
  records: Array<Record<string, unknown>>,
) {
  const columns: GoogleSheetColumn[] = [...googleSheetCoreColumns];
  const keys = new Set(columns.map((column) => column.key));
  const addColumn = (keyValue: unknown, labelValue?: unknown) => {
    const key = googleSheetKey(String(keyValue ?? ""));
    if (!key || keys.has(key) || googleSheetReservedKeys.has(key)) return;
    const label = String(labelValue ?? "").trim() || fieldLabel(key);
    columns.push({ key, label: label.slice(0, 120) });
    keys.add(key);
  };
  for (const field of analysisFields) addColumn(field.key, field.label);
  columns.push(...googleSheetServiceColumns, googleSheetCallIdColumn);
  return columns;
}

export function googleSheetCallRow(
  call: Record<string, unknown>,
  workflowValue: Record<string, unknown> | null = null,
  appointmentValue: Record<string, unknown> | null = null,
) {
  const workflow = objectValue(workflowValue);
  const appointment = objectValue(appointmentValue);
  const structuredOutput = objectValue(call.structuredOutput);
  const workflowData = objectValue(workflow.data);
  const callId = String(call._id ?? call.id ?? "").trim();
  const contactName = firstText(workflow, ["contactName"])
    || firstText(appointment, ["patientName"])
    || firstText(structuredOutput, ["caller_name", "customer_name", "patient_name", "name"]);
  const phone = firstText(workflow, ["contactPhone"])
    || firstText(appointment, ["patientPhone"])
    || (call.direction === "outbound"
      ? firstText(call, ["calledNumber", "callerNumber"])
      : firstText(call, ["callerNumber", "calledNumber"]));
  const email = firstText(workflowData, ["email", "customer_email", "caller_email"])
    || firstText(structuredOutput, ["email", "customer_email", "caller_email"]);
  const outcome = firstText(workflow, ["status"])
    || firstText(appointment, ["status"])
    || firstText(structuredOutput, ["outcome", "disposition"])
    || firstText(call, ["status"]);
  const noteParts: string[] = [];

  if (Object.keys(workflow).length) {
    const kind = firstText(workflow, ["kind"]);
    const summary = firstText(workflow, ["summary"]);
    const scheduledFor = firstText(workflow, ["scheduledForText"]);
    const reference = firstText(workflow, ["reference"]);
    if (kind) noteParts.push(`Type: ${fieldLabel(kind)}`);
    if (summary) noteParts.push(summary);
    if (scheduledFor) noteParts.push(`Scheduled for: ${scheduledFor}`);
    if (reference) noteParts.push(`Reference: ${reference}`);
    noteParts.push(...scalarDetails(workflowData, new Set([
      "name", "contact_name", "customer_name", "patient_name", "phone", "contact_phone",
      "customer_phone", "patient_phone", "email", "customer_email", "caller_email",
    ])));
  } else if (Object.keys(appointment).length) {
    const appointmentType = firstText(appointment, ["appointmentType"]);
    const startAt = appointment.startAt;
    const reference = firstText(appointment, ["bookingReference"]);
    const notes = firstText(appointment, ["notes"]);
    if (appointmentType) noteParts.push(`Type: ${appointmentType}`);
    if (startAt) noteParts.push(`Scheduled for: ${isoDate(startAt)}`);
    if (reference) noteParts.push(`Reference: ${reference}`);
    if (notes) noteParts.push(notes);
  } else {
    noteParts.push(...scalarDetails(structuredOutput, new Set([
      "caller_name", "customer_name", "patient_name", "name", "email", "customer_email",
      "caller_email", "outcome", "disposition",
    ])));
  }

  return [
    isoDate(workflow.createdAt ?? appointment.createdAt ?? call.endedAt ?? call.createdAt),
    contactName,
    phone,
    email,
    outcome,
    noteParts.join(" | ").slice(0, 5000),
    callId,
  ];
}

function recordTime(value: Record<string, unknown>) {
  const date = new Date(String(value.createdAt ?? value.startAt ?? ""));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function googleSheetCallRows(
  call: Record<string, unknown>,
  workflows: Record<string, unknown>[],
  appointments: Record<string, unknown>[],
) {
  const outcomes = [
    ...workflows.map((workflow) => ({ workflow, appointment: null, time: recordTime(workflow) })),
    ...appointments.map((appointment) => ({ workflow: null, appointment, time: recordTime(appointment) })),
  ].sort((left, right) => left.time - right.time);
  if (!outcomes.length) return [googleSheetCallRow(call)];
  return outcomes.map(({ workflow, appointment }) => googleSheetCallRow(call, workflow, appointment));
}

async function appendPostCallGoogleSheet(ownerId: string, call: Record<string, unknown>) {
  const callId = String(call._id ?? call.id ?? "").trim();
  const agentId = String(call.agentId ?? "").trim();
  const campaignLeadId = String(call.campaignLeadId ?? "").trim();
  if (!callId || !agentId) throw new Error("Cannot sync Google Sheets without a call and agent ID.");
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("googleSheets analysisPlan").lean();
  const sheets = agent?.googleSheets;
  if (!sheets?.enabled || !sheets.spreadsheetId || !sheets.sheetName) {
    throw new Error("Google Sheets is no longer enabled or its destination is incomplete.");
  }
  const [workflows, appointments, campaignLead] = await Promise.all([
    NativeWorkflowRecordModel.find({ ownerId, agentId, callId }).sort({ createdAt: 1 }).lean(),
    NativeAppointmentModel.find({ ownerId, agentId, callId }).sort({ createdAt: 1 }).lean(),
    campaignLeadId
      ? CampaignLeadModel.findOne({ _id: campaignLeadId, ownerId }).select("name phone email company customFields").lean()
      : Promise.resolve(null),
  ]);
  const exportCall = campaignLead ? { ...call, campaignLead } : call;
  const records = googleSheetCallRecords(
    exportCall,
    workflows as unknown as Record<string, unknown>[],
    appointments as unknown as Record<string, unknown>[],
  );
  return appendGoogleSheetRecords(
    ownerId,
    sheets.spreadsheetId,
    sheets.sheetName,
    googleSheetExportColumns(
      (agent?.analysisPlan?.fields ?? []) as Array<{ key?: unknown; label?: unknown }>,
      records,
    ),
    records,
  );
}

async function configuredPostCallProviders(ownerId: string, call: Record<string, unknown>) {
  const agentId = String(call.agentId ?? "").trim();
  const [connected, agent] = await Promise.all([
    ProviderIntegrationModel.find({
      ownerId,
      status: "connected",
      provider: { $in: ["slack", "hubspot"] },
    }).distinct("provider") as Promise<string[]>,
    agentId
      ? VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("googleSheets").lean()
      : Promise.resolve(null),
  ]);
  const providers: PostCallProvider[] = [];
  if (connected.includes("slack")) providers.push("slack");
  if (connected.includes("hubspot")) providers.push("hubspot");
  if (
    agent?.googleSheets?.enabled
    && agent.googleSheets.spreadsheetId
    && agent.googleSheets.sheetName
  ) providers.push("google_sheets");
  return providers;
}

export async function runPostCallIntegrations(ownerId: string, call: Record<string, unknown>) {
  const connected = await configuredPostCallProviders(ownerId, call);
  const attempts = [
    ...(connected.includes("slack") ? [{ provider: "slack", task: notifySlack(ownerId, call) }] : []),
    ...(connected.includes("hubspot") ? [{ provider: "hubspot", task: logHubSpotCall(ownerId, call) }] : []),
    ...(connected.includes("google_sheets") ? [{ provider: "google_sheets", task: appendPostCallGoogleSheet(ownerId, call) }] : []),
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
  const providers = await configuredPostCallProviders(ownerId, call);
  const callId = String(call._id ?? call.id ?? "");
  if (!callId) throw new Error("Cannot queue integrations without a call ID.");
  const campaignLeadId = String(call.campaignLeadId ?? "");
  if (campaignLeadId) {
    await CampaignLeadModel.updateOne(
      { _id: campaignLeadId, ownerId },
      {
        $set: {
          crmSyncStatus: providers.includes("hubspot") ? "pending" : "not_configured",
          crmSyncError: "",
        },
      },
    );
  }
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
    else if (delivery.provider === "hubspot") await logHubSpotCall(delivery.ownerId, delivery.payload as Record<string, unknown>);
    else await appendPostCallGoogleSheet(delivery.ownerId, delivery.payload as Record<string, unknown>);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const attemptNumber = delivery.attempts + 1;
  const retryDelaySeconds = errorMessage ? integrationRetrySeconds[attemptNumber - 1] : undefined;
  const completedAt = new Date();
  const updated = await IntegrationDeliveryModel.findOneAndUpdate(
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
  if (delivery.provider === "hubspot") {
    const payload = delivery.payload as Record<string, unknown>;
    const campaignLeadId = String(payload.campaignLeadId ?? "");
    if (campaignLeadId) {
      await CampaignLeadModel.updateOne(
        { _id: campaignLeadId, ownerId: delivery.ownerId },
        {
          $set: {
            crmSyncStatus: errorMessage ? (retryDelaySeconds ? "pending" : "failed") : "synced",
            crmSyncError: errorMessage.slice(0, 1000),
            crmSyncedAt: errorMessage ? null : completedAt,
          },
        },
      );
    }
  }
  return updated;
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
