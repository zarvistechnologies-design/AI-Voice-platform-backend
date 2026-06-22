import type { Response } from "express";
import { isValidObjectId } from "mongoose";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import {
  providerModels,
  voiceAgentLimits,
  VoiceAgentModel,
  type VoiceAgentDocument,
} from "../models/VoiceAgent.js";
import {
  createInboundRoute,
  getAgentDispatchHealth,
  createWebCallToken,
  livekitConfiguration,
  reconcileOpenCallRecordsForAgent,
  startOutboundCall,
} from "../services/livekitService.js";
import { createVoicePreview } from "../services/voicePreviewService.js";
import {
  connectVobiz,
  disconnectVobiz,
  getVobizCredentials,
  getVobizIntegration,
} from "../services/integrationService.js";
import {
  configureVobizLiveKitInbound,
  findVobizOwnedNumber,
  listVobizInventory,
  listVobizOwnedNumbers,
  purchaseVobizNumber,
  type VobizCredentials,
  type VobizNumber,
} from "../services/vobizService.js";
import { HttpError } from "../utils/httpError.js";
import { assertCallCapacity } from "../services/billingService.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { executeWebhookTool, objectArgs } from "../services/agentToolService.js";

const agentTemplates = {
  support: { name: "Customer Support", team: "Support", prompt: "You are a calm customer support specialist. Diagnose the caller's issue, explain each next step clearly, and escalate when needed.", firstMessage: "Hello, you have reached support. How can I help today?" },
  appointments: { name: "Appointment Scheduler", team: "Scheduling", prompt: "You schedule appointments efficiently. Ask for the caller's preferred time, use Calendly tools when available, and confirm all details.", firstMessage: "Hello, I can help schedule your appointment. What day works best?" },
  leads: { name: "Lead Qualifier", team: "Sales", prompt: "You qualify inbound leads conversationally. Learn their needs, timeline, budget, and decision process, then summarize the opportunity.", firstMessage: "Hello, thanks for your interest. May I ask a few quick questions about what you need?" },
  faq: { name: "FAQ Assistant", team: "Information", prompt: "Answer questions using only the approved knowledge documents. If the answer is not available, offer a human handoff.", firstMessage: "Hello, what can I help you find today?" },
} as const;

function ownerId(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) {
    throw new HttpError(401, "Authentication required.");
  }
  return request.organization.id;
}

function agentAuditSnapshot(agent: VoiceAgentDocument) {
  return {
    id: agent.id,
    name: agent.name,
    team: agent.team,
    status: agent.status,
    phone: agent.phone,
    pipelineMode: agent.pipelineMode,
    realtimeProvider: agent.realtimeProvider,
    llmProvider: agent.llmProvider,
    sttProvider: agent.sttProvider,
    ttsProvider: agent.ttsProvider,
    maxConcurrentCalls: agent.maxConcurrentCalls,
    businessHoursEnabled: agent.businessHoursEnabled,
    version: agent.version,
  };
}

function phoneAuditSnapshot(phone: unknown) {
  const raw = phone && typeof phone === "object" && "toObject" in phone
    ? (phone as { toObject(): Record<string, unknown> }).toObject()
    : phone as Record<string, unknown> | null;
  if (!raw) return {};
  const agent = raw.agentId && typeof raw.agentId === "object"
    ? raw.agentId as Record<string, unknown>
    : null;
  return {
    id: String(raw._id ?? ""),
    number: raw.number,
    label: raw.label,
    direction: raw.direction,
    status: raw.status,
    provider: raw.provider,
    agentId: agent?._id ? String(agent._id) : String(raw.agentId ?? ""),
  };
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function requireE164(value: unknown) {
  const number = cleanText(value);
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    throw new HttpError(400, "Phone number must use E.164 format, for example +919876543210.");
  }
  return number;
}

function phoneDirection(value: unknown): "Inbound" | "Outbound" | "Both" {
  return value === "Inbound" || value === "Outbound" || value === "Both" ? value : "Both";
}

function validateAgentText(field: "prompt" | "firstMessage", value: string) {
  const limit = voiceAgentLimits[field];
  if (value.length > limit) {
    throw new HttpError(
      400,
      `${field === "prompt" ? "Prompt" : "First message"} must be ${limit.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  return value;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function optionalUrl(value: unknown) {
  const normalized = cleanText(value);
  if (normalized && !isHttpUrl(normalized)) throw new HttpError(400, "Webhook URLs must use HTTP or HTTPS.");
  return normalized;
}

const toolNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{1,79}$/;
const keyNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/;
const toolMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const toolParameterTypes = ["string", "number", "boolean", "object"] as const;
const analysisFieldTypes = ["string", "number", "boolean", "date", "enum"] as const;
const firstMessageModes = ["assistant-speaks-first", "user-speaks-first", "model-generated"] as const;

function sanitizeToolParameter(raw: unknown) {
  const parameter = raw as Record<string, unknown>;
  const name = cleanText(parameter.name);
  if (!keyNamePattern.test(name)) {
    throw new HttpError(400, "Tool parameter names must start with a letter and contain only letters, numbers, and underscores.");
  }
  const type = toolParameterTypes.includes(parameter.type as typeof toolParameterTypes[number])
    ? parameter.type as typeof toolParameterTypes[number]
    : "string";
  return {
    name,
    type,
    description: cleanText(parameter.description).slice(0, 500),
    required: parameter.required === true,
  };
}

function sanitizeTool(raw: unknown) {
  const tool = raw as Record<string, unknown>;
  const name = cleanText(tool.name);
  const url = cleanText(tool.url);
  if (!toolNamePattern.test(name)) {
    throw new HttpError(400, "Tool names must contain only letters, numbers, and underscores.");
  }
  if (!isHttpUrl(url)) throw new HttpError(400, `Tool ${name} needs a valid HTTP or HTTPS URL.`);
  const method = toolMethods.includes(tool.method as typeof toolMethods[number])
    ? tool.method as typeof toolMethods[number]
    : "POST";
  const parameters = Array.isArray(tool.parameters)
    ? tool.parameters.slice(0, 20).map(sanitizeToolParameter)
    : [];
  if (Array.isArray(tool.parameters) && tool.parameters.length > 20) {
    throw new HttpError(400, "A tool can have at most 20 parameters.");
  }
  return {
    name,
    description: cleanText(tool.description).slice(0, 500),
    method,
    url,
    timeoutSeconds: Math.min(30, Math.max(1, Number(tool.timeoutSeconds) || 8)),
    enabled: tool.enabled !== false,
    parameters,
  };
}

function sanitizeAnalysisField(raw: unknown) {
  const field = raw as Record<string, unknown>;
  const key = cleanText(field.key);
  const label = cleanText(field.label, key);
  if (!keyNamePattern.test(key)) {
    throw new HttpError(400, "Analysis field keys must start with a letter and contain only letters, numbers, and underscores.");
  }
  if (!label) throw new HttpError(400, "Analysis fields need a label.");
  const type = analysisFieldTypes.includes(field.type as typeof analysisFieldTypes[number])
    ? field.type as typeof analysisFieldTypes[number]
    : "string";
  const options = Array.isArray(field.options)
    ? [...new Set(field.options.map((option) => cleanText(option)).filter(Boolean))]
        .slice(0, 30)
        .map((option) => option.slice(0, 80))
    : [];
  return {
    key,
    label: label.slice(0, 120),
    type,
    description: cleanText(field.description).slice(0, 500),
    required: field.required === true,
    options,
  };
}

function sanitizeDtmf(value: unknown) {
  const normalized = cleanText(value).replace(/\s+/g, "");
  if (normalized && !/^[0-9*#wWpP,]+$/.test(normalized)) {
    throw new HttpError(400, "DTMF sequence can only contain digits, *, #, commas, and w/p pause characters.");
  }
  return normalized.slice(0, 80);
}

function applyAdvancedAgentSettings(agent: VoiceAgentDocument, body: Record<string, unknown>) {
  for (const [field, min, max] of [["maxConcurrentCalls", 1, 100], ["voiceSpeed", 0.5, 2], ["voicePitch", -10, 10]] as const) {
    if (typeof body[field] === "number") agent.set(field, Math.min(max, Math.max(min, body[field])));
  }
  if (firstMessageModes.includes(body.firstMessageMode as typeof firstMessageModes[number])) {
    const mode = body.firstMessageMode as typeof firstMessageModes[number];
    agent.set("firstMessageMode", mode);
    agent.set("behavior.userStartsFirst", mode === "user-speaks-first");
  }
  if (["low", "medium", "high"].includes(String(body.interruptionSensitivity))) agent.set("interruptionSensitivity", body.interruptionSensitivity);
  if (["none", "office", "cafe", "street"].includes(String(body.backgroundNoise))) agent.set("backgroundNoise", body.backgroundNoise);
  if (typeof body.callbackEmail === "string") agent.callbackEmail = body.callbackEmail.trim();
  if (typeof body.businessHoursEnabled === "boolean") agent.businessHoursEnabled = body.businessHoursEnabled;
  if (typeof body.businessHours === "object" && body.businessHours) {
    const hours = body.businessHours as Record<string, unknown>;
    if (typeof hours.timezone === "string") agent.set("businessHours.timezone", hours.timezone.trim() || "UTC");
    if (Array.isArray(hours.schedule)) {
      agent.set("businessHours.schedule", hours.schedule.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          day: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].includes(String(item.day)) ? item.day : "mon",
          enabled: item.enabled !== false,
          start: /^\d{2}:\d{2}$/.test(String(item.start)) ? item.start : "09:00",
          end: /^\d{2}:\d{2}$/.test(String(item.end)) ? item.end : "17:00",
        };
      }).slice(0, 7));
    }
  }
  const behavior = typeof body.behavior === "object" && body.behavior ? body.behavior as Record<string, unknown> : {};
  const booleanBehavior = [
    "interruptions",
    "userStartsFirst",
    "autoFillResponses",
    "agentCanTerminate",
    "voicemailHandling",
    "dtmfDial",
  ] as const;
  for (const field of booleanBehavior) {
    if (typeof behavior[field] === "boolean") agent.set(`behavior.${field}`, behavior[field]);
  }
  if (typeof body.firstMessageMode !== "string" && typeof behavior.userStartsFirst === "boolean") {
    agent.set("firstMessageMode", behavior.userStartsFirst ? "user-speaks-first" : "assistant-speaks-first");
  }
  const numberBehavior = {
    responseDelayMs: [0, 5000],
    maxCallDurationSeconds: [30, 7200],
    maxIdleSeconds: [60, 600],
  } as const;
  for (const [field, [min, max]] of Object.entries(numberBehavior)) {
    const value = behavior[field];
    if (typeof value === "number") agent.set(`behavior.${field}`, Math.min(max, Math.max(min, value)));
  }
  for (const field of ["transferPhone", "timezone", "voicemailMessage"] as const) {
    if (typeof behavior[field] === "string") agent.set(`behavior.${field}`, behavior[field].trim());
  }
  if (["leave-message", "hangup"].includes(String(behavior.voicemailAction))) {
    agent.set("behavior.voicemailAction", behavior.voicemailAction);
  }
  if (["fast", "balanced", "patient"].includes(String(behavior.endpointingMode))) {
    agent.set("behavior.endpointingMode", behavior.endpointingMode);
  }
  if ("dtmfSequence" in behavior) agent.set("behavior.dtmfSequence", sanitizeDtmf(behavior.dtmfSequence));

  const callSettings =
    typeof body.callSettings === "object" && body.callSettings
      ? body.callSettings as Record<string, unknown>
      : {};
  for (const field of ["recordingEnabled", "doNotCallDetection", "sessionContinuation", "memoryEnabled"] as const) {
    if (typeof callSettings[field] === "boolean") agent.set(`callSettings.${field}`, callSettings[field]);
  }

  if (Array.isArray(body.tools)) {
    if (body.tools.length > 20) throw new HttpError(400, "An agent can have at most 20 tools.");
    agent.set("tools", body.tools.map(sanitizeTool));
  }

  if (Array.isArray(body.knowledgeDocuments)) {
    if (body.knowledgeDocuments.length > 20) throw new HttpError(400, "An agent can have at most 20 knowledge documents.");
    agent.set(
      "knowledgeDocuments",
      body.knowledgeDocuments.map((raw) => {
        const document = raw as Record<string, unknown>;
        const name = cleanText(document.name);
        const content = cleanText(document.content);
        if (!name || !content) throw new HttpError(400, "Knowledge documents need a name and content.");
        return { name, content, status: document.status === "disabled" ? "disabled" : "ready" };
      }),
    );
  }

  if (Array.isArray(body.dynamicVariables)) {
    agent.set(
      "dynamicVariables",
      [...new Set(body.dynamicVariables.map((value) => cleanText(value)).filter((value) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(value)))].slice(0, 50),
    );
  }
  if ("prefetchWebhook" in body) agent.prefetchWebhook = optionalUrl(body.prefetchWebhook);
  if ("endOfCallWebhook" in body) agent.endOfCallWebhook = optionalUrl(body.endOfCallWebhook);

  const analysisPlan =
    typeof body.analysisPlan === "object" && body.analysisPlan
      ? body.analysisPlan as Record<string, unknown>
      : {};
  if (typeof analysisPlan.enabled === "boolean") agent.set("analysisPlan.enabled", analysisPlan.enabled);
  if (Array.isArray(analysisPlan.fields)) {
    if (analysisPlan.fields.length > 20) throw new HttpError(400, "An analysis plan can have at most 20 fields.");
    agent.set("analysisPlan.fields", analysisPlan.fields.map(sanitizeAnalysisField));
  }

  const widget = typeof body.widget === "object" && body.widget ? body.widget as Record<string, unknown> : {};
  if (typeof widget.enabled === "boolean") agent.set("widget.enabled", widget.enabled);
  for (const field of ["publicKey", "buttonText", "accentColor"] as const) {
    if (typeof widget[field] === "string") agent.set(`widget.${field}`, widget[field].trim());
  }
  if (Array.isArray(widget.allowedDomains)) {
    agent.set("widget.allowedDomains", widget.allowedDomains.map((value) => cleanText(value)).filter(Boolean).slice(0, 20));
  }
  if (["light", "dark", "auto"].includes(String(widget.theme))) agent.set("widget.theme", widget.theme);
  if (["bottom-right", "bottom-left", "inline"].includes(String(widget.position))) agent.set("widget.position", widget.position);
}

async function findAgent(request: AuthenticatedRequest) {
  const agent = await VoiceAgentModel.findOne({
    _id: request.params.agentId ?? request.body.agentId,
    ownerId: ownerId(request),
  });
  if (!agent) {
    throw new HttpError(404, "Voice agent not found.");
  }
  return agent;
}

async function assertAgentAvailable(agent: VoiceAgentDocument, allowDraft: boolean) {
  if (agent.status === "Paused") throw new HttpError(409, "This agent is paused.");
  if (!allowDraft && agent.status !== "Live") throw new HttpError(409, "Set this agent to Live before handling phone calls.");
  if (agent.businessHoursEnabled && agent.businessHours?.schedule?.length) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: agent.businessHours.timezone || "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
    const day = String(parts.weekday ?? "").toLowerCase().slice(0, 3);
    const time = `${parts.hour}:${parts.minute}`;
    const schedule = agent.businessHours.schedule.find((item) => item.day === day);
    if (!schedule?.enabled || time < schedule.start || time > schedule.end) {
      throw new HttpError(409, "This agent is outside its configured business hours.");
    }
  }
  await reconcileOpenCallRecordsForAgent(agent);
  const active = await CallDetailRecordModel.countDocuments({
    ownerId: agent.ownerId,
    agentId: agent._id,
    status: { $in: ["initiated", "ringing", "active"] },
  });
  if (active >= agent.maxConcurrentCalls) {
    throw new HttpError(429, `This agent has reached its ${agent.maxConcurrentCalls} concurrent call limit.`);
  }
}

async function ensureStarterAgent(userId: string) {
  const existing = await VoiceAgentModel.findOne({ ownerId: userId });
  if (existing) {
    return;
  }

  await VoiceAgentModel.create({
    ownerId: userId,
    name: "Maya",
    team: "Growth Desk",
    status: "Live",
    phone: "",
    language: "English",
    voice: "alloy",
    providerModel: "openai-realtime",
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: "gpt-realtime",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
    firstMessage: "Hi, this is Maya from Growth Desk. How can I help today?",
    prompt:
      "You are a concise, helpful realtime voice assistant. Answer naturally, ask one question at a time, and never use markdown while speaking.",
  });
}

export async function getVoiceConfig(_request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(_request);
  const vobiz = await getVobizIntegration(userId);
  response.json({
    ...livekitConfiguration(),
    vobiz: {
      configured: vobiz?.status === "connected",
      accountId: vobiz?.accountId ?? "",
      status: vobiz?.status ?? "disconnected",
      ownedNumberCount: vobiz?.metadata?.ownedNumberCount ?? 0,
    },
  });
}

export async function listAgents(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  await ensureStarterAgent(userId);
  response.json({ agents: await VoiceAgentModel.find({ ownerId: userId }).sort({ createdAt: 1 }) });
}

export async function createAgent(request: AuthenticatedRequest, response: Response) {
  const agent = await VoiceAgentModel.create({
    ownerId: ownerId(request),
    name: cleanText(request.body.name, "New agent"),
    team: cleanText(request.body.team, "Voice team"),
    status: "Draft",
    phone: "",
    language: cleanText(request.body.language, "English"),
    voice: cleanText(request.body.voice, "alloy"),
    providerModel: providerModels.includes(request.body.providerModel)
      ? request.body.providerModel
      : "openai-realtime",
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: "gpt-realtime",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
    prompt: cleanText(
      request.body.prompt,
      "You are a helpful realtime voice assistant. Keep spoken responses concise.",
    ),
    firstMessage: cleanText(request.body.firstMessage, "Hello, how can I help today?"),
  });
  await recordAuditLog(request, {
    action: "agent.created",
    resource: "agent",
    resourceId: agent.id,
    after: agentAuditSnapshot(agent),
  });
  response.status(201).json({ agent });
}

export async function updateAgent(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const before = agentAuditSnapshot(agent);
  const fields = [
    "name",
    "team",
    "status",
    "phone",
    "language",
    "voice",
    "prompt",
    "firstMessage",
    "pipelineMode",
    "realtimeProvider",
    "realtimeModel",
    "llmProvider",
    "llmModel",
    "sttProvider",
    "sttModel",
    "ttsProvider",
    "ttsModel",
  ] as const;
  for (const field of fields) {
    if (typeof request.body[field] === "string") {
      const value = request.body[field].trim();
      agent.set(
        field,
        field === "prompt" || field === "firstMessage"
          ? validateAgentText(field, value)
          : value,
      );
    }
  }
  if (providerModels.includes(request.body.providerModel)) {
    agent.providerModel = request.body.providerModel;
  }
  if (typeof request.body.temperature === "number") {
    agent.temperature = Math.min(2, Math.max(0, request.body.temperature));
  }
  applyAdvancedAgentSettings(agent, request.body as Record<string, unknown>);
  agent.version += 1;
  await agent.save();
  await recordAuditLog(request, {
    action: "agent.updated",
    resource: "agent",
    resourceId: agent.id,
    before,
    after: agentAuditSnapshot(agent),
  });
  response.json({ agent });
}

export async function testAgentTool(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const body = request.body as Record<string, unknown>;
  const toolId = cleanText(body.toolId);
  const rawTool =
    typeof body.tool === "object" && body.tool
      ? sanitizeTool(body.tool)
      : agent.tools.find((tool) => {
          const storedTool = tool as typeof tool & { _id?: unknown };
          return String(storedTool._id ?? "") === toolId || tool.name === toolId;
        });

  if (!rawTool) {
    throw new HttpError(404, "Tool not found.");
  }

  const tool = sanitizeTool(rawTool);
  const result = await executeWebhookTool(tool, objectArgs(body.args));
  if (!result.ok) {
    throw new HttpError(
      502,
      `Tool ${tool.name} returned HTTP ${result.status}: ${result.responseText || "No response body."}`,
    );
  }

  response.json({
    tool: { name: tool.name, method: tool.method, url: tool.url },
    result,
  });
}

export async function cloneAgent(request: AuthenticatedRequest, response: Response) {
  const source = await findAgent(request);
  const copy = source.toObject();
  delete (copy as Record<string, unknown>)._id;
  delete (copy as Record<string, unknown>).createdAt;
  delete (copy as Record<string, unknown>).updatedAt;
  const agent = await VoiceAgentModel.create({
    ...copy,
    ownerId: ownerId(request),
    name: `${source.name} copy`.slice(0, 80),
    status: "Draft",
    phone: "",
    version: 1,
    latencyMetrics: undefined,
  });
  await recordAuditLog(request, {
    action: "agent.cloned",
    resource: "agent",
    resourceId: agent.id,
    before: agentAuditSnapshot(source),
    after: agentAuditSnapshot(agent),
  });
  response.status(201).json({ agent });
}

export async function listAgentTemplates(_request: AuthenticatedRequest, response: Response) {
  response.json({ templates: Object.entries(agentTemplates).map(([id, template]) => ({ id, ...template })) });
}

export async function createAgentFromTemplate(request: AuthenticatedRequest, response: Response) {
  const template = agentTemplates[request.params.templateId as keyof typeof agentTemplates];
  if (!template) throw new HttpError(404, "Agent template not found.");
  const agent = await VoiceAgentModel.create({
    ownerId: ownerId(request),
    ...template,
    status: "Draft",
    phone: "",
    language: "English",
    voice: "alloy",
  });
  await recordAuditLog(request, {
    action: "agent.created_from_template",
    resource: "agent",
    resourceId: agent.id,
    after: { ...agentAuditSnapshot(agent), templateId: request.params.templateId },
  });
  response.status(201).json({ agent });
}

export async function deleteAgent(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  if (await PhoneNumberModel.exists({ ownerId: ownerId(request), agentId: agent._id })) {
    throw new HttpError(409, "Move or remove this agent's phone numbers before deleting it.");
  }
  const before = agentAuditSnapshot(agent);
  await agent.deleteOne();
  await recordAuditLog(request, {
    action: "agent.deleted",
    resource: "agent",
    resourceId: agent.id,
    before,
  });
  response.status(204).end();
}

export async function createWebToken(request: AuthenticatedRequest, response: Response) {
  await assertCallCapacity(ownerId(request));
  const agent = await findAgent(request);
  await assertAgentAvailable(agent, true);
  response.json(await createWebCallToken(agent, ownerId(request)));
}

export async function getAgentDispatchStatus(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const roomName = cleanText(request.query.roomName);
  const dispatchId = cleanText(request.query.dispatchId);
  if (!roomName) throw new HttpError(400, "roomName is required.");

  const call = await CallDetailRecordModel.findOne({
    ownerId: userId,
    livekitRoomName: roomName,
  }).select("_id");
  if (!call) throw new HttpError(404, "Call room not found.");

  response.json(await getAgentDispatchHealth(roomName, dispatchId));
}

export async function createOutboundCall(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  await assertCallCapacity(userId);
  const agent = await findAgent(request);
  await assertAgentAvailable(agent, false);
  const destination = requireE164(request.body.phoneNumber);
  const sourceNumber = await PhoneNumberModel.findOne({
    ownerId: userId,
    agentId: agent._id,
    direction: { $in: ["Outbound", "Both"] },
    status: "Ready",
  }).sort({ updatedAt: -1 });

  if (!sourceNumber) {
    throw new HttpError(
      409,
      "Import or buy a Vobiz number with Outbound or Both direction before starting outbound calls.",
    );
  }

  response
    .status(202)
    .json(await startOutboundCall(agent, userId, destination, sourceNumber.number));
}

export async function previewVoice(request: AuthenticatedRequest, response: Response) {
  const provider = cleanText(request.body.provider);
  if (!["openai", "gemini", "sarvam"].includes(provider)) {
    throw new HttpError(400, "Choose a supported voice provider.");
  }
  const mode = request.body.mode === "pipeline" ? "pipeline" : "realtime";
  const audio = await createVoicePreview({
    mode,
    provider: provider as "openai" | "gemini" | "sarvam",
    model: cleanText(request.body.model),
    voice: cleanText(request.body.voice, "alloy"),
    language: cleanText(request.body.language, "English"),
    text: cleanText(request.body.text),
    voiceSpeed: typeof request.body.voiceSpeed === "number" ? request.body.voiceSpeed : undefined,
  });

  response
    .set({
      "Content-Type": "audio/wav",
      "Content-Length": String(audio.byteLength),
      "Cache-Control": "no-store",
    })
    .send(audio);
}

export async function listPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const numbers = await PhoneNumberModel.find({ ownerId: ownerId(request) })
    .populate<{ agentId: VoiceAgentDocument }>("agentId")
    .sort({ createdAt: -1 });
  response.json({ numbers });
}

async function saveVobizRoute(input: {
  userId: string;
  agent: VoiceAgentDocument;
  credentials: VobizCredentials;
  number: VobizNumber;
  label?: string;
  direction: "Inbound" | "Outbound" | "Both";
}) {
  let dispatchRuleId = "";
  if (input.direction !== "Outbound") {
    dispatchRuleId = await activateVobizInboundRoute(
      input.credentials,
      input.agent,
      input.number.e164,
    );
  }

  const phone = await PhoneNumberModel.findOneAndUpdate(
    { ownerId: input.userId, number: input.number.e164 },
    {
      ownerId: input.userId,
      number: input.number.e164,
      label: cleanText(input.label, `${input.agent.name} line`),
      direction: input.direction,
      region: [input.number.region, input.number.country].filter(Boolean).join(", "),
      agentId: input.agent._id,
      inboundTrunkId: input.direction === "Outbound" ? "" : env.livekitSipInboundTrunkId,
      outboundTrunkId: input.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId,
      dispatchRuleId,
      provider: "Vobiz",
      providerNumberId: input.number.id,
      monthlyFee: input.number.monthly_fee ?? 0,
      currency: input.number.currency ?? "INR",
      status: "Ready",
    },
    { new: true, upsert: true, runValidators: true },
  ).populate<{ agentId: VoiceAgentDocument }>("agentId");

  input.agent.phone = input.number.e164;
  await input.agent.save();

  return phone;
}

async function activateVobizInboundRoute(
  credentials: VobizCredentials,
  agent: VoiceAgentDocument,
  phoneNumber: string,
) {
  const rule = await createInboundRoute(agent, phoneNumber);
  const dispatchRuleId = rule.sipDispatchRuleId;
  if (!dispatchRuleId) {
    throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
  }
  await configureVobizLiveKitInbound(credentials, phoneNumber);
  return dispatchRuleId;
}

export async function activateInboundPhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const existing = await PhoneNumberModel.findOne({
    _id: request.params.phoneNumberId,
    ownerId: userId,
  });
  if (!existing) throw new HttpError(404, "Phone number not found.");

  const requestedDirection = typeof request.body.direction === "string"
    ? phoneDirection(request.body.direction)
    : undefined;
  if (requestedDirection === "Outbound") {
    throw new HttpError(400, "Inbound activation needs direction Inbound or Both.");
  }

  const requestedAgentId = cleanText(request.body.agentId);
  const agentId = requestedAgentId || String(existing.agentId ?? "");
  if (!agentId || !isValidObjectId(agentId)) {
    throw new HttpError(409, "Assign an agent before activating inbound calls.");
  }

  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId: userId });
  if (!agent) throw new HttpError(404, "Voice agent not found.");

  const before = phoneAuditSnapshot(existing);
  const label = cleanText(request.body.label);
  const credentials = await getVobizCredentials(userId);
  const nextDirection = requestedDirection ?? (existing.direction === "Outbound" ? "Both" : existing.direction);
  const dispatchRuleId = await activateVobizInboundRoute(credentials, agent, existing.number);

  const phone = await PhoneNumberModel.findOneAndUpdate(
    { _id: existing._id, ownerId: userId },
    {
      agentId: agent._id,
      direction: nextDirection,
      label: label || existing.label,
      inboundTrunkId: env.livekitSipInboundTrunkId,
      outboundTrunkId: nextDirection === "Inbound" ? "" : env.livekitSipOutboundTrunkId,
      dispatchRuleId,
      status: "Ready",
    },
    { new: true, runValidators: true },
  ).populate<{ agentId: VoiceAgentDocument }>("agentId");

  agent.phone = existing.number;
  await agent.save();

  await recordAuditLog(request, {
    action: "phone_number.inbound_activated",
    resource: "phone_number",
    resourceId: String(phone?._id ?? existing._id),
    before,
    after: phoneAuditSnapshot(phone),
  });
  response.json({ number: phone });
}

export async function listVobizAccountNumbers(request: AuthenticatedRequest, response: Response) {
  const credentials = await getVobizCredentials(ownerId(request));
  response.json(await listVobizOwnedNumbers(credentials));
}

export async function browseVobizInventory(request: AuthenticatedRequest, response: Response) {
  const credentials = await getVobizCredentials(ownerId(request));
  response.json(
    await listVobizInventory(credentials, {
      country: cleanText(request.query.country),
      search: cleanText(request.query.search),
      page: Number(request.query.page) || 1,
      perPage: Number(request.query.perPage) || 25,
    }),
  );
}

export async function importPhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agent = await findAgent(request);
  const credentials = await getVobizCredentials(userId);
  const vobizNumber = await findVobizOwnedNumber(
    credentials,
    requireE164(request.body.phoneNumber),
  );
  const phone = await saveVobizRoute({
    userId,
    agent,
    credentials,
    number: vobizNumber,
    label: request.body.label,
    direction: phoneDirection(request.body.direction),
  });
  await recordAuditLog(request, {
    action: "phone_number.imported",
    resource: "phone_number",
    resourceId: String(phone?._id ?? ""),
    after: phoneAuditSnapshot(phone),
  });
  response.status(201).json({ number: phone });
}

export async function purchasePhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agent = await findAgent(request);
  const credentials = await getVobizCredentials(userId);
  const vobizNumber = await purchaseVobizNumber(
    credentials,
    requireE164(request.body.phoneNumber),
    cleanText(request.body.currency),
  );
  const phone = await saveVobizRoute({
    userId,
    agent,
    credentials,
    number: vobizNumber,
    label: request.body.label,
    direction: phoneDirection(request.body.direction),
  });
  await recordAuditLog(request, {
    action: "phone_number.purchased",
    resource: "phone_number",
    resourceId: String(phone?._id ?? ""),
    after: phoneAuditSnapshot(phone),
  });
  response.status(201).json({ number: phone });
}

export async function syncPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const credentials = await getVobizCredentials(userId);
  const [vobiz, routes] = await Promise.all([
    listVobizOwnedNumbers(credentials),
    PhoneNumberModel.find({ ownerId: userId }).populate<{ agentId: VoiceAgentDocument | null }>("agentId"),
  ]);

  let repaired = 0;
  let needsSetup = 0;
  const errors: { number: string; message: string }[] = [];

  for (const route of routes) {
    if (route.direction === "Outbound") {
      if (route.status === "Ready" && route.outboundTrunkId !== env.livekitSipOutboundTrunkId) {
        route.outboundTrunkId = env.livekitSipOutboundTrunkId;
        await route.save();
        repaired += 1;
      }
      continue;
    }

    if (!route.agentId) {
      route.status = "Needs setup";
      route.inboundTrunkId = "";
      route.dispatchRuleId = "";
      await route.save();
      needsSetup += 1;
      errors.push({ number: route.number, message: "Assign an agent before creating an inbound route." });
      continue;
    }

    try {
      const dispatchRuleId = await activateVobizInboundRoute(credentials, route.agentId, route.number);
      route.inboundTrunkId = env.livekitSipInboundTrunkId;
      route.outboundTrunkId = route.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId;
      route.dispatchRuleId = dispatchRuleId;
      route.status = "Ready";
      await route.save();
      repaired += 1;
    } catch (error) {
      route.status = "Needs setup";
      await route.save().catch(() => undefined);
      needsSetup += 1;
      errors.push({
        number: route.number,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  response.json({
    vobiz,
    routes: {
      total: routes.length,
      repaired,
      needsSetup,
      errors,
    },
  });
}

export async function getVobizConnection(request: AuthenticatedRequest, response: Response) {
  const integration = await getVobizIntegration(ownerId(request));
  response.json({
    connected: integration?.status === "connected",
    accountId: integration?.accountId ?? "",
    status: integration?.status ?? "disconnected",
    ownedNumberCount: integration?.metadata?.ownedNumberCount ?? 0,
    lastVerifiedAt: integration?.lastVerifiedAt ?? null,
  });
}

export async function connectVobizAccount(request: AuthenticatedRequest, response: Response) {
  const authId = cleanText(request.body.authId);
  const authToken = cleanText(request.body.authToken);
  if (!/^(MA|SA)_[A-Za-z0-9]+$/.test(authId)) {
    throw new HttpError(400, "Enter a valid Vobiz Auth ID.");
  }
  if (authToken.length < 20) {
    throw new HttpError(400, "Enter a valid Vobiz Auth Token.");
  }
  const integration = await connectVobiz(ownerId(request), { authId, authToken });
  await recordAuditLog(request, {
    action: "integration.connected",
    resource: "integration",
    resourceId: "vobiz",
    after: { provider: "vobiz", accountId: integration.accountId, status: integration.status },
  });
  response.json({
    connected: true,
    accountId: integration.accountId,
    status: integration.status,
    ownedNumberCount: integration.metadata?.ownedNumberCount ?? 0,
    lastVerifiedAt: integration.lastVerifiedAt,
  });
}

export async function disconnectVobizAccount(request: AuthenticatedRequest, response: Response) {
  await disconnectVobiz(ownerId(request));
  await recordAuditLog(request, {
    action: "integration.disconnected",
    resource: "integration",
    resourceId: "vobiz",
    before: { provider: "vobiz" },
  });
  response.status(204).end();
}
