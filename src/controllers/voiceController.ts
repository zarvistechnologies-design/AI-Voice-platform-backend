import type { Request, Response } from "express";
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
  deleteInboundRoute,
  getAgentDispatchHealth,
  getAgentRuntimeSnapshot,
  createWebCallToken,
  livekitConfiguration,
  refreshInboundRoutesForAgent,
  removeInboundRoute,
  removePhoneNumberRouting,
  reconcileOpenCallRecordsForAgent,
  startOutboundCall,
} from "../services/livekitService.js";
import { resolveElevenLabsLanguageProvider } from "../services/modelCatalog.js";
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
  unassignVobizNumberFromTrunk,
  type VobizCredentials,
  type VobizNumber,
} from "../services/vobizService.js";
import { verifyExotelNumber, verifyTwilioNumber } from "../services/telephonyProviderService.js";
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
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function safeTimezone(value: unknown, fallback = "UTC") {
  const timezone = cleanText(value, fallback);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return fallback;
  }
}

function normalizeDomain(value: unknown) {
  const raw = cleanText(value).toLowerCase().replace(/\/+$/g, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.host.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

function originFromRequest(request: Request) {
  const body = request.body as Record<string, unknown> | undefined;
  const fromBody = cleanText(body?.parentOrigin ?? body?.origin);
  const fromQuery = cleanText(request.query.parentOrigin ?? request.query.origin);
  const fromHeader = cleanText(request.get("origin")) || cleanText(request.get("referer"));
  return fromBody || fromQuery || fromHeader;
}

function widgetMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key))
      .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 500) : item])
      .slice(0, 50),
  );
}

function callMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const entries: [string, string | number | boolean][] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key)) continue;
    if (typeof item === "string") {
      const trimmed = item.trim().slice(0, 500);
      if (trimmed) entries.push([key, trimmed]);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      entries.push([key, item]);
    } else if (typeof item === "boolean") {
      entries.push([key, item]);
    }
    if (entries.length >= 50) break;
  }
  return Object.fromEntries(entries);
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

function telephonyProvider(value: unknown): "Twilio" | "Exotel" | "Vobiz" {
  const provider = cleanText(value, "Vobiz").toLowerCase();
  if (provider === "twilio") return "Twilio";
  if (provider === "exotel") return "Exotel";
  if (provider === "vobiz") return "Vobiz";
  throw new HttpError(400, "Choose Twilio, Exotel, or Vobiz as the telephony provider.");
}

async function assertPhoneNumberAvailable(userId: string, number: string) {
  const existing = await PhoneNumberModel.findOne({
    number,
    ownerId: { $ne: userId },
  }).select("_id");
  if (existing) {
    throw new HttpError(
      409,
      "This phone number is already connected to another workspace. Remove it there before importing it here.",
    );
  }
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
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const blockedToolHeaders = new Set(["connection", "content-length", "host", "transfer-encoding"]);
const toolMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const toolParameterTypes = ["string", "number", "boolean", "object"] as const;
const analysisFieldTypes = ["string", "number", "boolean", "date", "enum"] as const;
const firstMessageModes = ["assistant-speaks-first", "user-speaks-first", "model-generated"] as const;

function sanitizeToolHeaders(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 30) throw new HttpError(400, "A tool can have at most 30 headers.");
  return Object.fromEntries(
    entries.flatMap(([rawKey, rawValue]) => {
      const key = rawKey.trim();
      if (!key) return [];
      if (!headerNamePattern.test(key)) {
        throw new HttpError(400, "Tool header names must be valid HTTP header names.");
      }
      if (blockedToolHeaders.has(key.toLowerCase())) {
        throw new HttpError(400, `Tool header ${key} cannot be set manually.`);
      }
      const value = cleanText(rawValue).slice(0, 1000);
      return value ? [[key, value]] : [];
    }),
  );
}

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
  const url = cleanText(tool.url || tool.webhook);
  if (!toolNamePattern.test(name)) {
    throw new HttpError(400, "Tool names must contain only letters, numbers, and underscores.");
  }
  if (!isHttpUrl(url)) throw new HttpError(400, `Tool ${name} needs a valid HTTP or HTTPS URL.`);
  const method = toolMethods.includes(tool.method as typeof toolMethods[number])
    ? tool.method as typeof toolMethods[number]
    : "POST";
  const rawParameters = Array.isArray(tool.parameters) ? tool.parameters : tool.params;
  const parameters = Array.isArray(rawParameters)
    ? rawParameters.slice(0, 20).map(sanitizeToolParameter)
    : [];
  if (Array.isArray(rawParameters) && rawParameters.length > 20) {
    throw new HttpError(400, "A tool can have at most 20 parameters.");
  }
  const messages = Array.isArray(tool.messages)
    ? tool.messages.map((message) => cleanText(message).slice(0, 500)).filter(Boolean).slice(0, 5)
    : [];
  return {
    name,
    description: cleanText(tool.description).slice(0, 500),
    method,
    url,
    headers: sanitizeToolHeaders(tool.headers || tool.header),
    timeoutSeconds: Math.min(30, Math.max(1, Number(tool.timeoutSeconds ?? tool.timeout) || 8)),
    enabled: tool.enabled !== false,
    parameters,
    runAfterCall: tool.runAfterCall === true || tool.run_after_call === true,
    executeAfterMessage: tool.executeAfterMessage === true || tool.execute_after_message === true,
    excludeSessionId: tool.excludeSessionId === false || tool.exclude_session_id === false ? false : true,
    messages,
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
    if (typeof hours.timezone === "string") agent.set("businessHours.timezone", safeTimezone(hours.timezone));
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
    maxIdleSeconds: [10, 600],
  } as const;
  for (const [field, [min, max]] of Object.entries(numberBehavior)) {
    const value = behavior[field];
    if (typeof value === "number") agent.set(`behavior.${field}`, Math.min(max, Math.max(min, value)));
  }
  for (const field of ["transferPhone", "timezone", "voicemailMessage"] as const) {
    if (typeof behavior[field] === "string") {
      agent.set(`behavior.${field}`, field === "timezone" ? safeTimezone(behavior[field]) : behavior[field].trim());
    }
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
    _id: request.params.agentId ?? request.body?.agentId,
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
    const timezone = safeTimezone(agent.businessHours.timezone);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
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

async function findPublicWidgetAgent(request: Request) {
  const agentId = cleanText(request.params.agentId ?? request.body?.agentId);
  const publicKey = cleanText(request.query.k ?? request.query.key ?? request.body?.publicKey);
  if (!isValidObjectId(agentId)) throw new HttpError(400, "Valid agentId is required.");
  if (!publicKey) throw new HttpError(401, "Widget public key is required.");

  const agent = await VoiceAgentModel.findById(agentId);
  if (!agent || !agent.widget?.enabled) {
    throw new HttpError(404, "Widget is not available.");
  }
  if (!agent.widget.publicKey || agent.widget.publicKey !== publicKey) {
    throw new HttpError(401, "Invalid widget key.");
  }

  const requestDomain = normalizeDomain(originFromRequest(request));
  const allowedDomains = (agent.widget.allowedDomains ?? []).map(normalizeDomain).filter(Boolean);
  if (allowedDomains.length && (!requestDomain || !allowedDomains.includes(requestDomain))) {
    throw new HttpError(403, "This domain is not allowed for this widget.");
  }

  return { agent, requestDomain };
}

export async function getPublicWidgetAgent(request: Request, response: Response) {
  const { agent } = await findPublicWidgetAgent(request);
  await assertAgentAvailable(agent, false);
  const widget = agent.widget!;
  response.json({
    agent: {
      id: agent.id,
      name: agent.name,
      enabled: widget.enabled,
      theme: widget.theme,
      position: widget.position,
      buttonText: widget.buttonText,
      accentColor: widget.accentColor,
    },
  });
}

export async function createPublicWidgetToken(request: Request, response: Response) {
  const { agent, requestDomain } = await findPublicWidgetAgent(request);
  await assertCallCapacity(String(agent.ownerId));
  await assertAgentAvailable(agent, false);
  const metadata = widgetMetadata(request.body?.metadata);
  response.json(await createWebCallToken(agent, String(agent.ownerId), {
    participantName: "Website visitor",
    metadata: {
      ...metadata,
      WidgetDomain: requestDomain,
      WidgetOrigin: originFromRequest(request),
    },
  }));
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
    ...(await livekitConfiguration()),
    vobiz: {
      configured: vobiz?.status === "connected",
      accountId: vobiz?.accountId ?? "",
      status: vobiz?.status ?? "disconnected",
      ownedNumberCount: vobiz?.metadata?.ownedNumberCount ?? 0,
    },
  });
}

export async function listElevenLabsLanguageVoices(request: AuthenticatedRequest, response: Response) {
  ownerId(request);
  const language = cleanText(request.query.language, "");
  if (!language) throw new HttpError(400, "Choose a language before loading ElevenLabs voices.");
  const provider = await resolveElevenLabsLanguageProvider(language);
  response.json({ language, provider });
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
  let routingWarning = "";
  try {
    const routeRefresh = await refreshInboundRoutesForAgent(agent);
    routingWarning = routeRefresh.errors.join(" ");
  } catch (error) {
    routingWarning = error instanceof Error ? error.message : String(error);
  }
  await recordAuditLog(request, {
    action: "agent.updated",
    resource: "agent",
    resourceId: agent.id,
    before,
    after: agentAuditSnapshot(agent),
  });
  response.json({
    agent,
    routingWarning,
  });
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
  const result = await executeWebhookTool(tool, objectArgs(body.args), {
    session_id: cleanText(body.sessionId, "dashboard-test"),
    call_id: cleanText(body.callId, "dashboard-test"),
    agent_id: agent.id,
    owner_id: agent.ownerId,
  });
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

export async function streamAgentRuntime(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const userId = ownerId(request);

  response.status(200);
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write("retry: 2000\n\n");

  let closed = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  const callChanges = CallDetailRecordModel.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace"] },
          "fullDocument.ownerId": userId,
          "fullDocument.agentId": agent._id,
        },
      },
    ],
    { fullDocument: "updateLookup" },
  );
  const agentChanges = VoiceAgentModel.watch([
    { $match: { "documentKey._id": agent._id } },
  ]);
  const phoneChanges = PhoneNumberModel.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
          $or: [
            { "fullDocument.ownerId": userId },
            { "fullDocumentBeforeChange.ownerId": userId },
          ],
        },
      },
    ],
    { fullDocument: "updateLookup" },
  );

  const emitSnapshot = async () => {
    if (closed) return;
    const currentAgent = await VoiceAgentModel.findOne({ _id: agent._id, ownerId: userId });
    if (!currentAgent) {
      response.write(`event: runtime_error\ndata: ${JSON.stringify({ message: "Voice agent no longer exists." })}\n\n`);
      response.end();
      return;
    }
    const snapshot = await getAgentRuntimeSnapshot(currentAgent);
    if (!closed) {
      response.write(`event: runtime\nid: ${Date.now()}\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }
  };

  const scheduleSnapshot = () => {
    if (closed || emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      void emitSnapshot().catch((error) => {
        if (!closed) {
          response.write(`event: runtime_error\ndata: ${JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          })}\n\n`);
        }
      });
    }, 40);
  };

  callChanges.on("change", scheduleSnapshot);
  agentChanges.on("change", scheduleSnapshot);
  phoneChanges.on("change", scheduleSnapshot);

  const heartbeat = setInterval(() => {
    if (!closed) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);
  heartbeat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    if (emitTimer) clearTimeout(emitTimer);
    clearInterval(heartbeat);
    void callChanges.close().catch(() => undefined);
    void agentChanges.close().catch(() => undefined);
    void phoneChanges.close().catch(() => undefined);
  };

  callChanges.on("error", (error) => {
    if (!closed) {
      response.write(`event: runtime_error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      response.end();
    }
    close();
  });
  agentChanges.on("error", (error) => {
    if (!closed) {
      response.write(`event: runtime_error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      response.end();
    }
    close();
  });
  phoneChanges.on("error", (error) => {
    if (!closed) {
      response.write(`event: runtime_error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      response.end();
    }
    close();
  });
  request.on("close", close);

  await emitSnapshot();
}

export async function createOutboundCall(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  await assertCallCapacity(userId);
  const agent = await findAgent(request);
  await assertAgentAvailable(agent, false);
  const destination = requireE164(request.body.phoneNumber);
  const requestedPhoneNumberId = cleanText(request.body.phoneNumberId);
  const sourceNumberFilter = {
    ownerId: userId,
    agentId: agent._id,
    direction: { $in: ["Outbound", "Both"] },
    status: "Ready",
  };
  const sourceNumber = requestedPhoneNumberId
    ? isValidObjectId(requestedPhoneNumberId)
      ? await PhoneNumberModel.findOne({
          ...sourceNumberFilter,
          _id: requestedPhoneNumberId,
        })
      : null
    : await PhoneNumberModel.findOne(sourceNumberFilter).sort({ updatedAt: -1 });

  if (requestedPhoneNumberId && !isValidObjectId(requestedPhoneNumberId)) {
    throw new HttpError(400, "Invalid caller ID phone number.");
  }

  if (!sourceNumber) {
    throw new HttpError(
      409,
      requestedPhoneNumberId
        ? "Selected caller ID must be Ready, outbound-capable, and assigned to this agent."
        : "Import or buy a Vobiz number with Outbound or Both direction before starting outbound calls.",
    );
  }

  response
    .status(202)
    .json(await startOutboundCall(agent, userId, destination, sourceNumber.number, callMetadata(request.body.metadata)));
}

export async function previewVoice(request: AuthenticatedRequest, response: Response) {
  const provider = cleanText(request.body.provider);
  if (!["openai", "gemini", "sarvam", "elevenlabs"].includes(provider)) {
    throw new HttpError(400, "Choose a supported voice provider.");
  }
  const mode = request.body.mode === "pipeline" ? "pipeline" : "realtime";
  const audio = await createVoicePreview({
    mode,
    provider: provider as "openai" | "gemini" | "sarvam" | "elevenlabs",
    model: cleanText(request.body.model),
    voice: cleanText(request.body.voice, "alloy"),
    language: cleanText(request.body.language, "English"),
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

export async function createPhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const number = requireE164(request.body.phoneNumber);
  const provider = telephonyProvider(request.body.provider);
  if (await PhoneNumberModel.exists({ ownerId: userId, number })) {
    throw new HttpError(409, "This phone number has already been imported.");
  }
  await assertPhoneNumberAvailable(userId, number);

  let providerNumberId = number;
  let providerLabel = `${provider} number`;
  let region: string = provider;

  if (provider === "Twilio") {
    const verified = await verifyTwilioNumber({
      accountSid: cleanText(request.body.accountSid),
      apiKeySid: cleanText(request.body.apiKeySid),
      apiKeySecret: cleanText(request.body.apiKeySecret),
      apiRegion: ["us1", "au1", "ie1"].includes(request.body.apiRegion)
        ? request.body.apiRegion
        : "us1",
      phoneNumber: number,
    });
    providerNumberId = verified.id;
    providerLabel = verified.label;
    region = verified.region;
  } else if (provider === "Exotel") {
    const verified = await verifyExotelNumber({
      accountSid: cleanText(request.body.accountSid),
      apiKey: cleanText(request.body.apiKey),
      apiToken: cleanText(request.body.apiToken),
      dataCenter: request.body.dataCenter === "singapore" ? "singapore" : "mumbai",
      phoneNumber: number,
    });
    providerNumberId = verified.id;
    providerLabel = verified.label;
    region = verified.region;
  } else {
    const authId = cleanText(request.body.authId);
    const authToken = cleanText(request.body.authToken);
    if (!/^(MA|SA)_[A-Za-z0-9]+$/.test(authId)) throw new HttpError(400, "Enter a valid Vobiz Auth ID.");
    if (authToken.length < 20) throw new HttpError(400, "Enter a valid Vobiz Auth Token.");
    await connectVobiz(userId, { authId, authToken });
    const verified = await findVobizOwnedNumber({ authId, authToken }, number);
    providerNumberId = verified.id;
    providerLabel = `${verified.region || verified.country} Vobiz number`;
    region = [verified.region, verified.country].filter(Boolean).join(", ") || "Vobiz";
  }

  const phone = await PhoneNumberModel.create({
    ownerId: userId,
    number,
    label: cleanText(request.body.label, providerLabel),
    direction: phoneDirection(request.body.direction),
    region,
    provider,
    providerNumberId,
    status: "Needs setup",
  });
  await recordAuditLog(request, {
    action: "phone_number.imported",
    resource: "phone_number",
    resourceId: phone.id,
    after: phoneAuditSnapshot(phone),
  });
  response.status(201).json({ number: phone });
}

export async function assignPhoneNumberAgent(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const phone = await PhoneNumberModel.findOne({
    _id: request.params.phoneNumberId,
    ownerId: userId,
  });
  if (!phone) throw new HttpError(404, "Phone number not found.");

  const before = phoneAuditSnapshot(phone);
  const previousAgentId = phone.agentId ? String(phone.agentId) : "";
  const requestedAgentId = cleanText(request.body.agentId);
  let routingWarning = "";

  if (!requestedAgentId) {
    if (phone.dispatchRuleId || phone.direction !== "Outbound") {
      try {
        if (phone.dispatchRuleId) {
          await deleteInboundRoute(phone.dispatchRuleId, userId);
        } else {
          await removeInboundRoute(phone.number, userId);
        }
      } catch (error) {
        routingWarning = error instanceof Error ? error.message : String(error);
      }
    }

    if (previousAgentId) {
      await VoiceAgentModel.updateOne(
        { _id: previousAgentId, ownerId: userId, phone: phone.number },
        { $set: { phone: "" } },
      );
    }

    phone.agentId = null;
    phone.inboundTrunkId = "";
    phone.outboundTrunkId = "";
    phone.dispatchRuleId = "";
    phone.status = "Needs setup";
    await phone.save();
  } else {
    if (!isValidObjectId(requestedAgentId)) {
      throw new HttpError(400, "Invalid agent id.");
    }
    const agent = await VoiceAgentModel.findOne({ _id: requestedAgentId, ownerId: userId });
    if (!agent) throw new HttpError(404, "Voice agent not found.");

    let dispatchRuleId = "";
    let inboundTrunkId = "";
    let routeReady = phone.direction === "Outbound";

    try {
      if (phone.provider === "Vobiz") {
        const credentials = await getVobizCredentials(userId);
        if (phone.direction === "Outbound") {
          await findVobizOwnedNumber(credentials, phone.number);
        } else {
          const route = await activateVobizInboundRoute(credentials, agent, phone.number);
          dispatchRuleId = route.dispatchRuleId;
          inboundTrunkId = route.inboundTrunkId;
        }
      } else if (phone.direction !== "Outbound") {
        const rule = await createInboundRoute(agent, phone.number);
        dispatchRuleId = rule.sipDispatchRuleId;
        if (!dispatchRuleId) {
          throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
        }
        inboundTrunkId = rule.trunkIds[0] ?? "";
      }
      routeReady = phone.direction === "Outbound" || Boolean(dispatchRuleId);
    } catch (error) {
      routingWarning = error instanceof Error ? error.message : String(error);
      dispatchRuleId = "";
      inboundTrunkId = "";
      routeReady = false;
    }

    if (previousAgentId && previousAgentId !== requestedAgentId) {
      await VoiceAgentModel.updateOne(
        { _id: previousAgentId, ownerId: userId, phone: phone.number },
        { $set: { phone: "" } },
      );
    }

    phone.agentId = agent._id;
    phone.dispatchRuleId = dispatchRuleId;
    phone.inboundTrunkId = dispatchRuleId ? inboundTrunkId : "";
    phone.outboundTrunkId = phone.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId;
    phone.status = routeReady ? "Ready" : "Needs setup";
    await phone.save();
    agent.phone = phone.number;
    await agent.save();
  }

  const populated = await phone.populate<{ agentId: VoiceAgentDocument | null }>("agentId");
  await recordAuditLog(request, {
    action: requestedAgentId ? "phone_number.agent_assigned" : "phone_number.agent_unassigned",
    resource: "phone_number",
    resourceId: phone.id,
    before,
    after: phoneAuditSnapshot(populated),
  });
  response.json({ number: populated, routingWarning });
}

export async function deletePhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const phone = await PhoneNumberModel.findOne({
    _id: request.params.phoneNumberId,
    ownerId: userId,
  });
  if (!phone) throw new HttpError(404, "Phone number not found.");

  const before = phoneAuditSnapshot(phone);
  const warnings: string[] = [];
  const previousAgentId = phone.agentId ? String(phone.agentId) : "";

  if (phone.dispatchRuleId || phone.inboundTrunkId || phone.direction !== "Outbound") {
    try {
      await removePhoneNumberRouting(phone.number, userId);
    } catch (error) {
      warnings.push(`LiveKit cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (phone.provider === "Vobiz") {
    try {
      const credentials = await getVobizCredentials(userId);
      await unassignVobizNumberFromTrunk(credentials, phone.number);
    } catch (error) {
      warnings.push(`Vobiz cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (previousAgentId) {
    await VoiceAgentModel.updateOne(
      { _id: previousAgentId, ownerId: userId, phone: phone.number },
      { $set: { phone: "" } },
    );
  }

  await PhoneNumberModel.deleteOne({ _id: phone._id, ownerId: userId });
  await recordAuditLog(request, {
    action: "phone_number.deleted",
    resource: "phone_number",
    resourceId: phone.id,
    before,
    after: {},
  });

  response.json({ deleted: true, routingWarning: warnings.join(" ") });
}

async function saveVobizRoute(input: {
  userId: string;
  agent: VoiceAgentDocument;
  credentials: VobizCredentials;
  number: VobizNumber;
  label?: string;
  direction: "Inbound" | "Outbound" | "Both";
}) {
  await assertPhoneNumberAvailable(input.userId, input.number.e164);

  let dispatchRuleId = "";
  let inboundTrunkId = "";
  if (input.direction !== "Outbound") {
    const route = await activateVobizInboundRoute(
      input.credentials,
      input.agent,
      input.number.e164,
    );
    dispatchRuleId = route.dispatchRuleId;
    inboundTrunkId = route.inboundTrunkId;
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
      inboundTrunkId: input.direction === "Outbound" ? "" : inboundTrunkId,
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
  await configureVobizLiveKitInbound(credentials, phoneNumber);
  const rule = await createInboundRoute(agent, phoneNumber);
  const dispatchRuleId = rule.sipDispatchRuleId;
  if (!dispatchRuleId) {
    throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
  }
  return {
    dispatchRuleId,
    inboundTrunkId: rule.trunkIds[0] ?? "",
  };
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
  const route = await activateVobizInboundRoute(credentials, agent, existing.number);

  const phone = await PhoneNumberModel.findOneAndUpdate(
    { _id: existing._id, ownerId: userId },
    {
      agentId: agent._id,
      direction: nextDirection,
      label: label || existing.label,
      inboundTrunkId: route.inboundTrunkId,
      outboundTrunkId: nextDirection === "Inbound" ? "" : env.livekitSipOutboundTrunkId,
      dispatchRuleId: route.dispatchRuleId,
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
  const requestedNumber = requireE164(request.body.phoneNumber);
  await assertPhoneNumberAvailable(userId, requestedNumber);
  const vobizNumber = await findVobizOwnedNumber(
    credentials,
    requestedNumber,
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
  const requestedNumber = requireE164(request.body.phoneNumber);
  if (await PhoneNumberModel.exists({ ownerId: userId, number: requestedNumber })) {
    throw new HttpError(409, "This phone number is already in your inventory.");
  }
  await assertPhoneNumberAvailable(userId, requestedNumber);

  const credentials = await getVobizCredentials(userId);
  const vobizNumber = await purchaseVobizNumber(
    credentials,
    requestedNumber,
    cleanText(request.body.currency),
  );
  const direction = phoneDirection(request.body.direction);
  const requestedAgentId = cleanText(request.body.agentId);
  const agent = requestedAgentId ? await findAgent(request) : null;
  const phone = agent
    ? await saveVobizRoute({
        userId,
        agent,
        credentials,
        number: vobizNumber,
        label: request.body.label,
        direction,
      })
    : await PhoneNumberModel.create({
        ownerId: userId,
        number: vobizNumber.e164,
        label: cleanText(request.body.label, `${vobizNumber.region || vobizNumber.country} Vobiz number`),
        direction,
        region: [vobizNumber.region, vobizNumber.country].filter(Boolean).join(", ") || "Vobiz",
        agentId: null,
        inboundTrunkId: "",
        outboundTrunkId: "",
        dispatchRuleId: "",
        provider: "Vobiz",
        providerNumberId: vobizNumber.id,
        monthlyFee: vobizNumber.monthly_fee ?? 0,
        currency: vobizNumber.currency ?? cleanText(request.body.currency, "INR"),
        status: "Needs setup",
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
    PhoneNumberModel.find({ ownerId: userId, provider: "Vobiz" }).populate<{ agentId: VoiceAgentDocument | null }>("agentId"),
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
      const inboundRoute = await activateVobizInboundRoute(credentials, route.agentId, route.number);
      route.inboundTrunkId = inboundRoute.inboundTrunkId;
      route.outboundTrunkId = route.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId;
      route.dispatchRuleId = inboundRoute.dispatchRuleId;
      route.status = "Ready";
      await route.save();
      repaired += 1;
    } catch (error) {
      route.status = "Needs setup";
      route.inboundTrunkId = "";
      route.dispatchRuleId = "";
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
