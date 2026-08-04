import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
import { DigitalBotAgentConnectionModel } from "../models/DigitalBotAgentConnection.js";
import {
  callDigitalBotTool,
  connectDigitalBotIntegration,
  connectNativeIntegration,
  digitalbotToolDefinitions,
  disconnectDigitalBotIntegration,
  disconnectNativeIntegration,
  nativeProviders,
  type NativeProvider,
  verifyDigitalBotIntegration,
  verifyDigitalBotToolSignature,
} from "../services/integrationService.js";
import { HttpError } from "../utils/httpError.js";
import { env } from "../config/env.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";
import {
  completeGoogleAuthorization,
  disconnectGoogle,
  googleAuthorizationUrl,
  inspectGoogleSpreadsheet,
  listGoogleCalendars,
  appendGoogleSheetRow,
  createGoogleCalendarEvent,
} from "../services/googleWorkspaceService.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function provider(value: string): NativeProvider {
  if (nativeProviders.includes(value as NativeProvider)) return value as NativeProvider;
  throw new HttpError(404, "Integration provider not found.");
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeDigitalBotTime(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";

  const twentyFourHour = raw.match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2] ?? "0");
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const twelveHour = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?$/i);
  if (!twelveHour) return raw;

  let hour = Number(twelveHour[1]);
  const minute = Number(twelveHour[2] ?? "0");
  const meridiem = twelveHour[3].toLowerCase();
  if (hour < 1 || hour > 12) return raw;

  if (meridiem === "a") hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDigitalBotToolPayload(payload: Record<string, unknown>) {
  const next = { ...payload };
  for (const field of ["preferred_time", "appointment_time", "time"]) {
    const normalized = normalizeDigitalBotTime(next[field]);
    if (normalized) next[field] = normalized;
  }
  return next;
}

type DigitalBotIntegrationLike = {
  _id: unknown;
  status?: string;
  accountId?: string;
  lastVerifiedAt?: Date | string | null;
  metadata?: unknown;
  get?: (path: string) => unknown;
};

function integrationField(integration: DigitalBotIntegrationLike, field: string) {
  if (typeof integration.get === "function") return integration.get(field);
  return (integration as unknown as Record<string, unknown>)[field];
}

function safeDigitalBotIntegration(integration: DigitalBotIntegrationLike) {
  const metadata = (integration.metadata ?? {}) as Record<string, unknown>;
  const targetAgentName = String(integrationField(integration, "targetAgentName") ?? "");
  const targetAgentId = String(integrationField(integration, "targetAgentId") ?? "");
  const displayName = String(integrationField(integration, "displayName") ?? targetAgentName);
  return {
    id: "digitalbot",
    connected: integration.status === "connected",
    connectionId: String(integration._id),
    displayName,
    targetAgentId,
    targetAgentName,
    accountId: integration.accountId ?? "",
    status: integration.status,
    lastVerifiedAt: integration.lastVerifiedAt,
    metadata: {
      connectionId: metadata.connectionId ?? "",
      workspaceId: metadata.workspaceId ?? "",
      workspaceName: metadata.workspaceName ?? integration.accountId ?? "",
      branchId: metadata.branchId ?? "",
      branchName: metadata.branchName ?? "",
      permissions: Array.isArray(metadata.permissions) ? metadata.permissions : [],
      tokenPrefix: metadata.tokenPrefix ?? "",
    },
    delivery: null,
  };
}

async function attachDigitalBotToolsToAgent(ownerId: string, agentId: string) {
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId });
  if (!agent) throw new HttpError(404, "Agent not found.");

  const definitions = digitalbotToolDefinitions(ownerId, agent.id);
  const existing = agent.tools.filter((tool) => !definitions.some((definition) => definition.name === tool.name));
  if (existing.length + definitions.length > 20) {
    throw new HttpError(400, "This agent has too many tools to attach DigitalBot.");
  }
  agent.set("tools", [...existing, ...definitions]);

  const instruction = [
    "Use DigitalBot tools for appointment requests.",
    "Check availability before confirming an appointment.",
    "Do not promise a booking until DigitalBot confirms success.",
    "Use doctor_id when available; otherwise pass doctor_name.",
    "Ask for the patient name before booking.",
    "If DigitalBot returns alternative times, offer those times to the caller.",
    "Never invent availability.",
  ].join("\n");
  if (!agent.prompt.includes("Use DigitalBot tools for appointment requests.")) {
    agent.prompt = `${agent.prompt.trim()}\n\n${instruction}`.slice(0, 50000);
  }

  agent.version += 1;
  await agent.save();
  await invalidateDashboardCache(ownerId);
  return { agent, attachedTools: definitions.map((tool) => tool.name) };
}

export async function listIntegrations(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const [integrations, digitalBotAgentConnections, latestDeliveries] = await Promise.all([
    ProviderIntegrationModel.find({ ownerId }).sort({ provider: 1 }),
    DigitalBotAgentConnectionModel.find({ ownerId }).sort({ createdAt: -1 }),
    IntegrationDeliveryModel.find({ ownerId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  response.json({
    providers: ["vobiz", ...nativeProviders, "google", "digitalbot"].map((id) => {
      const providerIntegrations = integrations.filter((item) => item.provider === id);
      const integration = providerIntegrations[0];
      const digitalBotConnections = id === "digitalbot"
        ? [
            ...digitalBotAgentConnections.map((item) => safeDigitalBotIntegration(item)),
            ...providerIntegrations
              .filter((item) => !digitalBotAgentConnections.some((connection) => connection.targetAgentId === integrationField(item as DigitalBotIntegrationLike, "targetAgentId")))
              .map((item) => safeDigitalBotIntegration(item as DigitalBotIntegrationLike)),
          ]
        : [];
      return {
        id,
        connected: id === "digitalbot"
          ? digitalBotConnections.some((item) => item.connected)
          : integration?.status === "connected",
        accountId: integration?.accountId ?? "",
        status: integration?.status ?? "disconnected",
        lastVerifiedAt: integration?.lastVerifiedAt ?? null,
        metadata: id === "digitalbot"
          ? { connections: digitalBotConnections }
          : integration?.metadata ?? {},
        delivery: latestDeliveries.find((item) => item.provider === id)
          ? (() => {
              const item = latestDeliveries.find((delivery) => delivery.provider === id)!;
              return {
                status: item.status,
                attempts: item.attempts,
                errorMessage: item.errorMessage,
                deliveredAt: item.deliveredAt ?? null,
                updatedAt: item.updatedAt,
              };
            })()
          : null,
      };
    }),
  });
}

export async function connectDigitalBot(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.body.agentId);
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("name");
  if (!agent) throw new HttpError(404, "Choose a valid Vozon agent for this DigitalBot connection.");
  const integration = await connectDigitalBotIntegration(
    ownerId,
    cleanText(request.body.connectorToken ?? request.body.credential),
    {
      agentId: agent.id,
      agentName: agent.name,
      displayName: cleanText(request.body.name, `${agent.name} DigitalBot`),
    },
  );
  const attachment = await attachDigitalBotToolsToAgent(ownerId, agent.id);
  response.json({ connection: safeDigitalBotIntegration(integration), attachedTools: attachment.attachedTools });
}

export async function verifyDigitalBot(request: AuthenticatedRequest, response: Response) {
  const integration = await verifyDigitalBotIntegration(orgId(request), cleanText(request.params.agentId ?? request.body.agentId));
  response.json(safeDigitalBotIntegration(integration));
}

export async function disconnectDigitalBot(request: AuthenticatedRequest, response: Response) {
  await disconnectDigitalBotIntegration(orgId(request), cleanText(request.params.agentId ?? request.body.agentId));
  response.status(204).end();
}

export async function attachDigitalBotTools(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.body.agentId);
  await verifyDigitalBotIntegration(ownerId, agentId);
  response.json(await attachDigitalBotToolsToAgent(ownerId, agentId));
}

function proxyPayload(body: Record<string, unknown>) {
  const call = body.call && typeof body.call === "object" ? body.call as Record<string, unknown> : {};
  const patientPhone = cleanText(body.patient_phone)
    || cleanText(body.callerNumber)
    || cleanText(body.from_phone)
    || cleanText(body.from)
    || cleanText(call.callerNumber);
  return normalizeDigitalBotToolPayload({
    ...body,
    provider: "vozon",
    source: "voice_connector",
    call_id: cleanText(body.call_id),
    external_call_id: cleanText(body.call_id),
    external_agent_id: cleanText(body.agent_id),
    ...(patientPhone ? { patient_phone: patientPhone } : {}),
  });
}

async function proxyDigitalBotTool(request: AuthenticatedRequest, response: Response, action: "check-availability" | "book-appointment") {
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const ownerId = cleanText(body.owner_id);
  const agentId = cleanText(body.agent_id);
  const signature = cleanText(request.headers["x-vozon-digitalbot-tool"]);
  if (!ownerId || !agentId || !verifyDigitalBotToolSignature(ownerId, agentId, signature)) {
    throw new HttpError(401, "Invalid DigitalBot tool request.");
  }
  const agent = await VoiceAgentModel.exists({ _id: agentId, ownerId });
  if (!agent) throw new HttpError(401, "Invalid DigitalBot tool context.");
  const idempotencyKey = action === "book-appointment"
    ? `vozon:${ownerId}:${agentId}:${cleanText(body.call_id, cleanText(body.session_id, "no-call"))}:${cleanText(body.tool_request_id, "book")}`
    : "";
  const result = await callDigitalBotTool(ownerId, agentId, action, proxyPayload(body), idempotencyKey);
  response.json(result);
}

export async function proxyDigitalBotAvailability(request: AuthenticatedRequest, response: Response) {
  await proxyDigitalBotTool(request, response, "check-availability");
}

export async function proxyDigitalBotBooking(request: AuthenticatedRequest, response: Response) {
  await proxyDigitalBotTool(request, response, "book-appointment");
}

export async function connectIntegration(request: AuthenticatedRequest, response: Response) {
  const integration = await connectNativeIntegration(
    orgId(request),
    provider(request.params.provider),
    typeof request.body.credential === "string" ? request.body.credential : "",
  );
  response.json({
    id: integration.provider,
    connected: true,
    accountId: integration.accountId,
    status: integration.status,
    lastVerifiedAt: integration.lastVerifiedAt,
    metadata: integration.metadata,
  });
}

export async function disconnectIntegration(request: AuthenticatedRequest, response: Response) {
  await disconnectNativeIntegration(orgId(request), provider(request.params.provider));
  response.status(204).end();
}

export async function startGoogleOAuth(request: AuthenticatedRequest, response: Response) {
  response.json({ url: googleAuthorizationUrl(orgId(request)) });
}

export async function googleOAuthCallback(request: AuthenticatedRequest, response: Response) {
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!code || !state) throw new HttpError(400, "Google did not return an authorization code.");
  await completeGoogleAuthorization(orgId(request), code, state);
  response.redirect(`${env.clientUrl.replace(/\/$/, "")}/dashboard/integrations?google=connected`);
}

export async function removeGoogleConnection(request: AuthenticatedRequest, response: Response) {
  await disconnectGoogle(orgId(request));
  response.status(204).end();
}

export async function googleCalendars(request: AuthenticatedRequest, response: Response) {
  response.json({ calendars: await listGoogleCalendars(orgId(request)) });
}

export async function googleSpreadsheet(request: AuthenticatedRequest, response: Response) {
  response.json({ spreadsheet: await inspectGoogleSpreadsheet(orgId(request), String(request.body.spreadsheetId ?? "")) });
}

export async function testGoogleCalendar(request: AuthenticatedRequest, response: Response) {
  const start = new Date(Date.now() + 24 * 60 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const end = new Date(start.getTime() + 15 * 60_000);
  const event = await createGoogleCalendarEvent(orgId(request), {
    calendarId: String(request.body.calendarId ?? ""),
    title: "Vozon integration test",
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: String(request.body.timezone ?? "Asia/Kolkata"),
    description: "This test event confirms that Vozon can create appointments. You may delete it.",
  });
  response.json({ event });
}

export async function testGoogleSheet(request: AuthenticatedRequest, response: Response) {
  const result = await appendGoogleSheetRow(
    orgId(request),
    String(request.body.spreadsheetId ?? ""),
    String(request.body.sheetName ?? "Sheet1"),
    [new Date().toISOString(), "Vozon integration test", "success", "This row confirms the connection works."],
  );
  response.json({ result });
}
