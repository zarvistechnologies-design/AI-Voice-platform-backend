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

const digitalBotOriginalToolNames = new Set(["check_doctor_availability", "book_appointment"]);
const digitalBotConnectorToolNames = new Set(["digitalbot_check_availability", "digitalbot_book_appointment"]);
const digitalBotAppointmentToolNames = new Set([
  ...digitalBotOriginalToolNames,
  ...digitalBotConnectorToolNames,
]);

const legacyDigitalBotAppointmentInstruction = [
  "Use DigitalBot tools for appointment requests.",
  "Check availability before confirming an appointment.",
  "Do not promise a booking until DigitalBot confirms success.",
  "Use doctor_id when available; otherwise pass doctor_name.",
  "Ask for the patient name before booking.",
  "If DigitalBot returns alternative times, offer those times to the caller.",
  "Never invent availability.",
].join("\n");

const previousDigitalBotAppointmentInstruction = [
  "DigitalBot appointment tool instructions:",
  "Use check_doctor_availability before offering or booking an appointment time.",
  "Use book_appointment only after the caller confirms an available doctor, date, and time.",
  "Never use digitalbot_check_availability or digitalbot_book_appointment.",
  "Pass doctorId from the availability result when it is available; otherwise pass doctorName.",
  "Collect the patientName before booking. Use the caller number as patientPhone when available.",
  "Do not promise a booking until book_appointment returns success.",
  "Never invent doctor availability or appointment confirmation.",
].join("\n");

const digitalBotAppointmentInstruction = [
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

function stripDigitalBotAppointmentInstruction(prompt: string) {
  return [
    legacyDigitalBotAppointmentInstruction,
    previousDigitalBotAppointmentInstruction,
    digitalBotAppointmentInstruction,
  ].reduce((current, block) => current.replace(block, "").trim(), prompt);
}

function normalizeDigitalBotPromptToolNames(prompt: string) {
  return prompt
    .replace(/\bdigitalbot_check_availability\b/g, "check_doctor_availability")
    .replace(/\bdigitalbot_book_appointment\b/g, "book_appointment");
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

export async function attachDigitalBotToolsToAgent(ownerId: string, agentId: string) {
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId });
  if (!agent) throw new HttpError(404, "Agent not found.");

  const definitions = digitalbotToolDefinitions();
  const existingOriginalToolNames = new Set<string>();
  const preservedTools = agent.tools.filter((tool) => {
    if (digitalBotConnectorToolNames.has(tool.name)) return false;
    if (!digitalBotOriginalToolNames.has(tool.name)) return true;
    if (existingOriginalToolNames.has(tool.name)) return false;
    existingOriginalToolNames.add(tool.name);
    return true;
  });
  const missingDefinitions = definitions.filter((tool) => !existingOriginalToolNames.has(tool.name));
  if (preservedTools.length + missingDefinitions.length > 20) {
    throw new HttpError(400, "This agent has too many tools to attach DigitalBot.");
  }
  agent.set("tools", [...preservedTools, ...missingDefinitions]);

  const promptWithoutDigitalBotInstruction = stripDigitalBotAppointmentInstruction(
    normalizeDigitalBotPromptToolNames(agent.prompt),
  );
  agent.prompt = `${digitalBotAppointmentInstruction}\n\n${promptWithoutDigitalBotInstruction}`.trim().slice(0, 50000);

  agent.version += 1;
  await agent.save();
  await invalidateDashboardCache(ownerId);
  return {
    agent,
    attachedTools: definitions.map((tool) => tool.name),
    addedTools: missingDefinitions.map((tool) => tool.name),
    preservedTools: [...existingOriginalToolNames],
  };
}

async function removeDigitalBotToolsFromAgents(ownerId: string, agentIds: string[] = []) {
  const uniqueAgentIds = [...new Set(agentIds.map((id) => id.trim()).filter(Boolean))];
  const agents = await VoiceAgentModel.find(
    uniqueAgentIds.length
      ? { ownerId, _id: { $in: uniqueAgentIds } }
      : { ownerId },
  ).select("_id tools prompt").lean();
  let updatedAgents = 0;

  for (const agent of agents) {
    const currentTools = Array.isArray(agent.tools) ? agent.tools : [];
    const tools = currentTools.filter((tool) => !digitalBotAppointmentToolNames.has(tool.name));
    const currentPrompt = typeof agent.prompt === "string" ? agent.prompt : "";
    const prompt = stripDigitalBotAppointmentInstruction(currentPrompt);
    const nextPrompt = prompt || "You are a helpful voice assistant.";
    const toolsChanged = tools.length !== currentTools.length;
    const promptChanged = nextPrompt !== currentPrompt;
    if (!toolsChanged && !promptChanged) continue;

    await VoiceAgentModel.updateOne(
      { _id: agent._id, ownerId },
      {
        $set: { tools, prompt: nextPrompt },
        $inc: { version: 1 },
      },
    );
    updatedAgents += 1;
  }

  if (updatedAgents) await invalidateDashboardCache(ownerId);
  return { updatedAgents };
}

export async function listIntegrations(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const [integrations, digitalBotAgentConnections, latestDeliveries] = await Promise.all([
    ProviderIntegrationModel.find({ ownerId }).sort({ provider: 1 }),
    DigitalBotAgentConnectionModel.find({ ownerId }).sort({ createdAt: -1 }),
    IntegrationDeliveryModel.find({ ownerId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const hasDigitalBotConnection = digitalBotAgentConnections.length > 0
    || integrations.some((item) => item.provider === "digitalbot");
  if (!hasDigitalBotConnection) {
    await removeDigitalBotToolsFromAgents(ownerId);
  }
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
  const ownerId = orgId(request);
  const agentId = cleanText(request.params.agentId ?? request.body.agentId);
  await disconnectDigitalBotIntegration(ownerId, agentId);
  await removeDigitalBotToolsFromAgents(ownerId, agentId ? [agentId] : []);
  response.status(204).end();
}

export async function attachDigitalBotTools(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const agentId = cleanText(request.body.agentId);
  await verifyDigitalBotIntegration(ownerId, agentId);
  response.json(await attachDigitalBotToolsToAgent(ownerId, agentId));
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
