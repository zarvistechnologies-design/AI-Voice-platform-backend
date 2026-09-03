import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
import { DigitalBotAgentConnectionModel } from "../models/DigitalBotAgentConnection.js";
import {
  connectDigitalBotIntegration,
  connectNativeIntegration,
  digitalbotToolDefinitions,
  disconnectDigitalBotIntegration,
  disconnectNativeIntegration,
  nativeProviders,
  type NativeProvider,
  verifyDigitalBotIntegration,
} from "../services/integrationService.js";
import { HttpError } from "../utils/httpError.js";
import { env } from "../config/env.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";
import {
  digitalBotInstructionEnd,
  digitalBotInstructionStart,
  digitalBotToolActivationPlan,
  isDigitalBotManagedAppointmentTool,
  removeDigitalBotManagedTools,
  stripDigitalBotAppointmentInstruction,
} from "../services/digitalBotToolPolicy.js";
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

function digitalBotManagedInstruction(definitions: ReturnType<typeof digitalbotToolDefinitions>) {
  const names = new Set(definitions.map((tool) => tool.name));
  if (names.has("check_availability") && names.has("create_booking")) {
    return [
      "DigitalBot Hotel and Restaurant CRM tool instructions:",
      "This agent has exactly two DigitalBot booking tools: check_availability and create_booking.",
      "For hotel room availability or restaurant table availability, collect the required date, time, guest count, room preference, or party size, then call check_availability.",
      "Tell the caller only the room or table options returned by check_availability. Never invent room availability, table availability, prices, room numbers, or table numbers.",
      "Ask the caller to choose one exact returned option before booking.",
      "Call create_booking only after the caller accepts an exact optionId returned by check_availability.",
      "Confirm the booking only when create_booking returns success.",
      "If booking fails, explain the error briefly and offer to check another date, time, room type, or party size.",
      "Keep responses friendly, short, and conversational.",
    ].join("\n");
  }

  return [
  "DigitalBot appointment tool instructions:",
  "You have exactly two appointment tools: check_doctor_availability and book_appointment.",
  "When a caller asks about a doctor or appointment, collect the doctor name or specialization and the preferred date, then call check_doctor_availability.",
  "Tell the caller only the available times returned by check_doctor_availability. Never invent a doctor, date, or time.",
  "Ask the caller to choose one of the available times.",
  "Before booking, collect and confirm the patient name, patient phone number, doctor, appointment date, appointment time, and purpose or reason for the visit.",
  "Use the caller's phone number as patientPhone when it is available.",
  "Call book_appointment using the exact doctor ID/name, date, and time returned by check_doctor_availability. Do not ask the caller for a doctor ID.",
  "Confirm the appointment only when book_appointment returns success.",
  "If booking fails, explain the error briefly, check availability again if necessary, and offer another available time.",
  "Keep responses friendly, short, and conversational.",
  ].join("\n");
}

function managedDigitalBotAppointmentInstruction(definitions: ReturnType<typeof digitalbotToolDefinitions>) {
  return [
    digitalBotInstructionStart,
    digitalBotManagedInstruction(definitions),
    digitalBotInstructionEnd,
  ].join("\n");
}

function safeDigitalBotIntegration(integration: DigitalBotIntegrationLike, toolsActive = false) {
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
    toolsActive,
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

export async function attachDigitalBotToolsToAgent(
  ownerId: string,
  agentId: string,
  definitions = digitalbotToolDefinitions(),
) {
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId });
  if (!agent) throw new HttpError(404, "Agent not found.");

  const { tools, preservedTools, missingDefinitions } = digitalBotToolActivationPlan(
    agent.tools,
    definitions,
  );
  if (preservedTools.length + missingDefinitions.length > 20) {
    throw new HttpError(400, "This agent has too many tools to attach DigitalBot.");
  }
  agent.set("tools", tools);

  const promptWithoutDigitalBotInstruction = stripDigitalBotAppointmentInstruction(agent.prompt);
  agent.prompt = `${managedDigitalBotAppointmentInstruction(definitions)}\n\n${promptWithoutDigitalBotInstruction}`.trim().slice(0, 50000);

  agent.version += 1;
  await agent.save();
  await invalidateDashboardCache(ownerId);
  return {
    agent,
    attachedTools: definitions.map((tool) => tool.name),
    addedTools: missingDefinitions.map((tool) => tool.name),
    preservedTools: preservedTools.map((tool) => tool.name),
  };
}

async function removeDigitalBotToolsFromAgent(ownerId: string, agentId: string) {
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("_id tools prompt").lean();
  if (!agent) throw new HttpError(404, "Agent not found.");

  const currentTools = Array.isArray(agent.tools) ? agent.tools : [];
  const tools = removeDigitalBotManagedTools(currentTools);
  const currentPrompt = typeof agent.prompt === "string" ? agent.prompt : "";
  const prompt = stripDigitalBotAppointmentInstruction(currentPrompt);
  const nextPrompt = prompt || "You are a helpful voice assistant.";
  const toolsChanged = tools.length !== currentTools.length;
  const promptChanged = nextPrompt !== currentPrompt;
  if (!toolsChanged && !promptChanged) return { updatedAgents: 0 };

  await VoiceAgentModel.updateOne(
    { _id: agent._id, ownerId },
    {
      $set: { tools, prompt: nextPrompt },
      $inc: { version: 1 },
    },
  );
  await invalidateDashboardCache(ownerId);
  return { updatedAgents: 1 };
}

export async function listIntegrations(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const [integrations, digitalBotAgentConnections, latestDeliveries] = await Promise.all([
    ProviderIntegrationModel.find({ ownerId }).sort({ provider: 1 }),
    DigitalBotAgentConnectionModel.find({ ownerId }).sort({ createdAt: -1 }),
    IntegrationDeliveryModel.find({ ownerId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const digitalBotTargetAgentIds = [
    ...digitalBotAgentConnections.map((item) => item.targetAgentId),
    ...integrations
      .filter((item) => item.provider === "digitalbot")
      .map((item) => String(integrationField(item as DigitalBotIntegrationLike, "targetAgentId") ?? "")),
  ].filter(Boolean);
  const digitalBotAgents = digitalBotTargetAgentIds.length
    ? await VoiceAgentModel.find({ ownerId, _id: { $in: digitalBotTargetAgentIds } }).select("_id tools prompt").lean()
    : [];
  const activeToolsByAgentId = new Map(
    digitalBotAgents.map((agent) => [
      String(agent._id),
      String(agent.prompt ?? "").includes(digitalBotInstructionStart)
        || (agent.tools ?? []).some((tool) => isDigitalBotManagedAppointmentTool(tool)),
    ]),
  );
  response.json({
    providers: ["vobiz", ...nativeProviders, "google", "digitalbot"].map((id) => {
      const providerIntegrations = integrations.filter((item) => item.provider === id);
      const integration = providerIntegrations[0];
      const digitalBotConnections = id === "digitalbot"
        ? [
            ...digitalBotAgentConnections.map((item) => safeDigitalBotIntegration(
              item,
              activeToolsByAgentId.get(item.targetAgentId) ?? false,
            )),
            ...providerIntegrations
              .filter((item) => !digitalBotAgentConnections.some((connection) => connection.targetAgentId === integrationField(item as DigitalBotIntegrationLike, "targetAgentId")))
              .map((item) => {
                const targetAgentId = String(integrationField(item as DigitalBotIntegrationLike, "targetAgentId") ?? "");
                return safeDigitalBotIntegration(
                  item as DigitalBotIntegrationLike,
                  activeToolsByAgentId.get(targetAgentId) ?? false,
                );
              }),
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
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("name team status phone language");
  if (!agent) throw new HttpError(404, "Choose a valid Vozon agent for this DigitalBot connection.");
  const integration = await connectDigitalBotIntegration(
    ownerId,
    cleanText(request.body.connectorToken ?? request.body.credential),
    {
      agentId: agent.id,
      agentName: agent.name,
      agentPhone: agent.phone,
      agentTeam: agent.team,
      agentStatus: agent.status,
      agentLanguage: agent.language,
      displayName: cleanText(request.body.name, `${agent.name} DigitalBot`),
    },
  );
  response.json({ connection: safeDigitalBotIntegration(integration, false), attachedTools: [] });
}

export async function verifyDigitalBot(request: AuthenticatedRequest, response: Response) {
  const integration = await verifyDigitalBotIntegration(orgId(request), cleanText(request.params.agentId ?? request.body.agentId));
  response.json(safeDigitalBotIntegration(integration));
}

export async function disconnectDigitalBot(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.params.agentId ?? request.body.agentId);
  await disconnectDigitalBotIntegration(ownerId, agentId);
  await removeDigitalBotToolsFromAgent(ownerId, agentId);
  response.status(204).end();
}

export async function attachDigitalBotTools(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.body.agentId);
  const integration = await verifyDigitalBotIntegration(ownerId, agentId);
  const metadata = integration.metadata as Record<string, unknown> | null;
  response.json(await attachDigitalBotToolsToAgent(
    ownerId,
    agentId,
    digitalbotToolDefinitions(metadata?.toolDefinitions),
  ));
}

export async function setDigitalBotToolsState(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.params.agentId ?? request.body.agentId);
  const enabled = request.body.enabled === true;
  if (enabled) {
    const integration = await verifyDigitalBotIntegration(ownerId, agentId);
    const metadata = integration.metadata as Record<string, unknown> | null;
    const attachment = await attachDigitalBotToolsToAgent(
      ownerId,
      agentId,
      digitalbotToolDefinitions(metadata?.toolDefinitions),
    );
    response.json({ active: true, attachedTools: attachment.attachedTools, addedTools: attachment.addedTools });
    return;
  }
  await removeDigitalBotToolsFromAgent(ownerId, agentId);
  response.json({ active: false, attachedTools: [], addedTools: [] });
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
