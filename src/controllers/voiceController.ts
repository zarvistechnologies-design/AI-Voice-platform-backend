import type { Request, Response } from "express";
import { isValidObjectId, startSession, type ClientSession } from "mongoose";

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
  finalizeInboundRoute,
  getAgentDispatchHealth,
  getAgentRuntimeSnapshot,
  createWebCallToken,
  ensureVobizOutboundTrunk,
  livekitConfiguration,
  removeInboundRoute,
  removePhoneNumberRouting,
  reconcileOpenCallRecordsForAgent,
  rollbackInboundRoute,
  startOutboundCall,
} from "../services/livekitService.js";
import {
  connectVobiz,
  disconnectVobiz,
  getVobizCredentials,
  getVobizIntegration,
} from "../services/integrationService.js";
import {
  configureVobizLiveKitInbound,
  findVobizOwnedNumber,
  findVobizOwnedNumberWithAccount,
  listVobizInventory,
  listVobizOwnedNumbers,
  listVobizTrunks,
  purchaseVobizNumber,
  selectVobizOutboundTrunk,
  unassignVobizNumberFromTrunk,
  VobizPurchaseUnconfirmedError,
  type VobizCredentials,
  type VobizNumber,
} from "../services/vobizService.js";
import { verifyExotelNumber, verifyTwilioNumber } from "../services/telephonyProviderService.js";
import { HttpError } from "../utils/httpError.js";
import { assertCallCapacity } from "../services/billingService.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { recordAuditLog } from "../services/auditLogService.js";
import { executeWebhookTool, objectArgs } from "../services/agentToolService.js";
import { AgentCampaignSlotModel } from "../models/AgentCampaignSlot.js";
import { cloneAgentKnowledge, deleteAgentKnowledge } from "../services/knowledgeService.js";
import { missingPricingForStack } from "../services/modelPricingService.js";
import { effectiveCallLanguage } from "../services/callRecordService.js";
import { strictAutomaticLanguageSwitchingError } from "../services/languageSwitchingService.js";
import {
  defaultOpenAIRealtimeModel,
  ensureElevenLabsVoiceInstalled,
  normalizeGeminiRealtimeModel,
  normalizeOpenAIRealtimeModel,
} from "../services/modelCatalog.js";
import {
  cachedDashboardRead,
  invalidateDashboardCache,
} from "../services/dashboardCacheService.js";
import {
  phoneNumberConflictError,
  releasePhoneNumberOwnership,
  reservePhoneNumber,
  type PhoneNumberReservationLease,
} from "../services/phoneNumberReservationService.js";
import {
  acquirePhoneNumberMutation,
  adoptPhoneNumberMutation,
  phoneNumberMutationLeaseExpiry,
} from "../services/phoneNumberMutationService.js";
import { acquirePhoneNumberCallAdmission } from "../services/phoneNumberCallAdmissionService.js";

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

function assertAgentPricingReady(agent: VoiceAgentDocument) {
  const missing = missingPricingForStack({
    pipelineMode: agent.pipelineMode,
    realtimeProvider: agent.realtimeProvider,
    realtimeModel: agent.realtimeModel,
    llmProvider: agent.llmProvider,
    llmModel: agent.llmModel,
    sttProvider: agent.sttProvider,
    sttModel: agent.sttModel,
    ttsProvider: agent.ttsProvider,
    ttsModel: agent.ttsModel,
    language: effectiveCallLanguage(agent),
  });
  if (!missing.length) return;
  throw new HttpError(
    409,
    `Exact pricing is missing for ${missing.map((item) => `${item.provider}/${item.model}`).join(", ")}. Choose a priced model or add an exact MODEL_PRICING_OVERRIDES_JSON entry.`,
  );
}

function assertStrictAutomaticLanguageSwitchingReady(agent: VoiceAgentDocument) {
  if (!agent.multilingualEnabled || !agent.languageSwitchingEnabled) return;
  const message = strictAutomaticLanguageSwitchingError(agent);
  if (message) throw new HttpError(400, message);
}

function agentAuditSnapshot(agent: VoiceAgentDocument) {
  return {
    id: agent.id,
    name: agent.name,
    team: agent.team,
    status: agent.status,
    phone: agent.phone,
    language: agent.language,
    multilingualEnabled: agent.multilingualEnabled,
    languageSwitchingEnabled: agent.languageSwitchingEnabled,
    supportedLanguages: agent.supportedLanguages,
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

function cleanLanguageList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item)).filter((item) => item && item !== "Multilingual"))]
    : [];
}

function primaryLanguageFromInput(languageValue: unknown, supportedLanguagesValue: unknown, fallback = "English") {
  const language = cleanText(languageValue, fallback);
  if (language && language !== "Multilingual") return language;
  return cleanLanguageList(supportedLanguagesValue)[0] || fallback;
}

function normalizedSupportedLanguages(primaryLanguage: string, supportedLanguagesValue: unknown) {
  const configured = cleanLanguageList(supportedLanguagesValue).slice(0, 12);
  const primary = primaryLanguage || configured[0] || "English";
  return [
    primary,
    ...configured.filter((value) => value !== primary),
  ].slice(0, 12);
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

async function ensureOutboundTrunkForPhone(
  provider: string,
  credentials: VobizCredentials | null,
  number: string,
  direction: "Inbound" | "Outbound" | "Both",
) {
  if (direction === "Inbound") return "";
  if (provider === "Vobiz") {
    if (!credentials) throw new HttpError(409, "Connect Vobiz before configuring outbound routing.");
    const trunks = (await listVobizTrunks(credentials)).objects;
    const outboundTrunk = selectVobizOutboundTrunk(trunks);
    return ensureVobizOutboundTrunk(outboundTrunk.trunk_domain, number, {
      username: credentials.authId,
      password: credentials.authToken,
    });
  }
  if (env.livekitSipOutboundTrunkId) return env.livekitSipOutboundTrunkId;
  throw new HttpError(503, "Outbound phone routing is not configured.");
}

function telephonyProvider(value: unknown): "Twilio" | "Exotel" | "Vobiz" {
  const provider = cleanText(value, "Vobiz").toLowerCase();
  if (provider === "twilio") return "Twilio";
  if (provider === "exotel") return "Exotel";
  if (provider === "vobiz") return "Vobiz";
  throw new HttpError(400, "Choose Twilio, Exotel, or Vobiz as the telephony provider.");
}

async function runMongoTransaction<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await startSession();
  try {
    const result = await session.withTransaction(() => work(session));
    if (result === null || result === undefined) {
      throw new Error("MongoDB transaction completed without a result.");
    }
    return result;
  } finally {
    await session.endSession();
  }
}

async function markPhoneRouteNeedsSetup(
  phoneMutation: Awaited<ReturnType<typeof acquirePhoneNumberMutation>>,
  event: string,
) {
  try {
    await phoneMutation.updateLocked({
      $set: {
        status: "Needs setup",
        inboundTrunkId: "",
        dispatchRuleId: "",
      },
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event,
      phoneNumberId: phoneMutation.phone.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

function recoveredVobizNumber(value: Record<string, unknown> | null, e164: string) {
  if (!value || value.e164 !== e164 || typeof value.id !== "string") return null;
  return value as VobizNumber;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

async function rethrowPhoneNumberWriteError(error: unknown, userId: string, number: string): Promise<never> {
  if (isDuplicateKeyError(error)) throw await phoneNumberConflictError(userId, number);
  throw error;
}

async function recordPostCommitAudit(
  request: AuthenticatedRequest,
  input: Parameters<typeof recordAuditLog>[1],
) {
  try {
    await recordAuditLog(request, input);
  } catch (error) {
    // The primary mutation has already committed. Report success truthfully
    // and surface the audit failure to production logs for repair/alerting.
    console.error(JSON.stringify({
      event: "post-commit-audit-write-failed",
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? "",
      error: error instanceof Error ? error.message : String(error),
    }));
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
  const id = cleanText(parameter._id);
  const name = cleanText(parameter.name);
  if (!keyNamePattern.test(name)) {
    throw new HttpError(400, "Tool parameter names must start with a letter and contain only letters, numbers, and underscores.");
  }
  const type = toolParameterTypes.includes(parameter.type as typeof toolParameterTypes[number])
    ? parameter.type as typeof toolParameterTypes[number]
    : "string";
  return {
    ...(isValidObjectId(id) ? { _id: id } : {}),
    name,
    type,
    description: cleanText(parameter.description).slice(0, 500),
    required: parameter.required === true,
  };
}

function sanitizeTool(raw: unknown) {
  const tool = raw as Record<string, unknown>;
  const id = cleanText(tool._id);
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
    ...(isValidObjectId(id) ? { _id: id } : {}),
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
  const id = cleanText(field._id);
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
    ...(isValidObjectId(id) ? { _id: id } : {}),
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
  if (typeof body.multilingualEnabled === "boolean") {
    agent.multilingualEnabled = body.multilingualEnabled;
  }
  if (typeof body.languageSwitchingEnabled === "boolean") {
    agent.languageSwitchingEnabled = body.multilingualEnabled !== false && body.languageSwitchingEnabled;
  }
  if (!agent.multilingualEnabled) agent.languageSwitchingEnabled = false;
  if (agent.multilingualEnabled) {
    const supportedSource = Array.isArray(body.supportedLanguages)
      ? body.supportedLanguages
      : agent.supportedLanguages;
    const existingPrimary = agent.language && agent.language !== "Multilingual"
      ? agent.language
      : agent.supportedLanguages.find((value) => value && value !== "Multilingual") || "English";
    const primaryLanguage = primaryLanguageFromInput(body.language, supportedSource, existingPrimary);
    agent.language = primaryLanguage;
    agent.supportedLanguages = normalizedSupportedLanguages(primaryLanguage, supportedSource);
  } else if (Array.isArray(body.supportedLanguages)) {
    agent.supportedLanguages = normalizedSupportedLanguages(agent.language, body.supportedLanguages);
  }
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
    maxIdleSeconds: [5, 600],
  } as const;
  for (const [field, [min, max]] of Object.entries(numberBehavior)) {
    const value = behavior[field];
    if (typeof value === "number") agent.set(`behavior.${field}`, Math.min(max, Math.max(min, value)));
  }
  for (const field of ["transferPhone", "transferMessage", "timezone", "voicemailMessage"] as const) {
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
        const id = cleanText(document._id);
        const name = cleanText(document.name);
        const content = cleanText(document.content);
        if (!name || !content) throw new HttpError(400, "Knowledge documents need a name and content.");
        return {
          ...(isValidObjectId(id) ? { _id: id } : {}),
          name,
          content,
          status: document.status === "disabled" ? "disabled" : "ready",
        };
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
  if (body.googleCalendar && typeof body.googleCalendar === "object") {
    const config = body.googleCalendar as Record<string, unknown>;
    agent.set("googleCalendar.enabled", config.enabled === true);
    if (typeof config.calendarId === "string") agent.set("googleCalendar.calendarId", config.calendarId.trim());
    if (typeof config.calendarName === "string") agent.set("googleCalendar.calendarName", config.calendarName.trim());
    if (typeof config.timezone === "string") agent.set("googleCalendar.timezone", safeTimezone(config.timezone, "Asia/Kolkata"));
    if (typeof config.appointmentDurationMinutes === "number") {
      agent.set("googleCalendar.appointmentDurationMinutes", Math.min(480, Math.max(5, Math.round(config.appointmentDurationMinutes))));
    }
    if (config.enabled === true && !cleanText(config.calendarId)) throw new HttpError(400, "Choose a Google Calendar before enabling it.");
  }
  if (body.googleSheets && typeof body.googleSheets === "object") {
    const config = body.googleSheets as Record<string, unknown>;
    agent.set("googleSheets.enabled", config.enabled === true);
    for (const field of ["spreadsheetId", "spreadsheetName", "sheetName"] as const) {
      if (typeof config[field] === "string") agent.set(`googleSheets.${field}`, config[field].trim());
    }
    if (config.enabled === true && (!cleanText(config.spreadsheetId) || !cleanText(config.sheetName))) {
      throw new HttpError(400, "Choose a Google spreadsheet and sheet tab before enabling it.");
    }
  }

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
  const agentId = request.params.agentId ?? request.body?.agentId;
  if (!isValidObjectId(agentId)) {
    throw new HttpError(404, "Voice agent not found.");
  }
  const agent = await VoiceAgentModel.findOne({
    _id: agentId,
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
  assertAgentPricingReady(agent);
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
  const [activeNonCampaignCalls, campaignSlots] = await Promise.all([
    CallDetailRecordModel.countDocuments({
      ownerId: agent.ownerId,
      agentId: agent._id,
      $or: [{ campaignId: null }, { campaignId: { $exists: false } }],
      status: { $in: ["initiated", "ringing", "active"] },
    }),
    AgentCampaignSlotModel.countDocuments({ agentId: agent._id, leasedUntil: { $gt: new Date() } }),
  ]);
  const active = activeNonCampaignCalls + campaignSlots;
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
    realtimeModel: defaultOpenAIRealtimeModel,
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

async function loadDashboardVoiceConfig(userId: string) {
  const [configuration, vobiz] = await Promise.all([
    livekitConfiguration(),
    getVobizIntegration(userId),
  ]);
  return {
    ...configuration,
    vobiz: {
      configured: vobiz?.status === "connected",
      accountId: vobiz?.accountId ?? "",
      status: vobiz?.status ?? "disconnected",
      ownedNumberCount: vobiz?.metadata?.ownedNumberCount ?? 0,
    },
  };
}

function cachedDashboardVoiceConfig(userId: string) {
  return cachedDashboardRead(
    userId,
    "voice-config",
    () => loadDashboardVoiceConfig(userId),
    { isCacheable: (value) => value.modelCatalogReady === true },
  );
}

export async function getVoiceConfig(request: AuthenticatedRequest, response: Response) {
  response.json(await cachedDashboardVoiceConfig(ownerId(request)));
}

export async function listAgents(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const summaryOnly = request.query.view === "summary";
  const findAgents = () => {
    const query = VoiceAgentModel.find({ ownerId: userId }).sort({ createdAt: 1 });
    return summaryOnly ? query.select("name team status phone version").lean() : query;
  };
  const loadAgents = async () => {
    let agents = await findAgents();
    if (agents.length === 0) {
      await ensureStarterAgent(userId);
      agents = await findAgents();
    }
    return { agents };
  };
  response.json(
    summaryOnly
      ? await cachedDashboardRead(userId, "agent-summaries", loadAgents)
      : await loadAgents(),
  );
}

export async function getAgent(request: AuthenticatedRequest, response: Response) {
  response.json({ agent: await findAgent(request) });
}

export async function getAgentDashboard(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const [agent, config] = await Promise.all([
    findAgent(request),
    cachedDashboardVoiceConfig(userId),
  ]);
  response.json({ agent, config });
}

export async function createAgent(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const primaryLanguage = primaryLanguageFromInput(
    request.body.language,
    request.body.supportedLanguages,
    "English",
  );
  const multilingualEnabled =
    request.body.multilingualEnabled === true || cleanText(request.body.language) === "Multilingual";
  const agent = await VoiceAgentModel.create({
    ownerId: userId,
    name: cleanText(request.body.name, "New agent"),
    team: cleanText(request.body.team, "Voice team"),
    status: "Draft",
    phone: "",
    language: primaryLanguage,
    multilingualEnabled,
    languageSwitchingEnabled: multilingualEnabled && request.body.languageSwitchingEnabled === true,
    supportedLanguages: normalizedSupportedLanguages(primaryLanguage, request.body.supportedLanguages),
    voice: cleanText(request.body.voice, "alloy"),
    providerModel: providerModels.includes(request.body.providerModel)
      ? request.body.providerModel
      : "openai-realtime",
    pipelineMode: "realtime",
    realtimeProvider: "openai",
    realtimeModel: defaultOpenAIRealtimeModel,
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
  await invalidateDashboardCache(userId);
  await recordAuditLog(request, {
    action: "agent.created",
    resource: "agent",
    resourceId: agent.id,
    after: agentAuditSnapshot(agent),
  });
  response.status(201).json({ agent });
}

export async function updateAgent(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agent = await findAgent(request);
  const expectedVersion = Number(request.body.version);
  if (
    Number.isInteger(expectedVersion)
    && expectedVersion > 0
    && expectedVersion !== agent.version
  ) {
    throw new HttpError(409, "This agent was updated by another request. Refresh before saving again.");
  }
  const before = agentAuditSnapshot(agent);
  const fields = [
    "name",
    "team",
    "status",
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
  assertStrictAutomaticLanguageSwitchingReady(agent);
  if (agent.pipelineMode === "realtime") {
    agent.realtimeModel = agent.realtimeProvider === "gemini"
      ? normalizeGeminiRealtimeModel(agent.realtimeModel)
      : normalizeOpenAIRealtimeModel(agent.realtimeModel);
  }
  if (agent.pipelineMode === 'pipeline' && agent.ttsProvider === 'elevenlabs') {
    agent.voice = await ensureElevenLabsVoiceInstalled(agent.voice);
  }
  assertAgentPricingReady(agent);
  agent.version += 1;
  try {
    await agent.save();
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "VersionError") {
      throw new HttpError(409, "This agent was updated by another request. Refresh before saving again.");
    }
    throw error;
  }
  await Promise.all([
    invalidateDashboardCache(userId),
    recordPostCommitAudit(request, {
      action: "agent.updated",
      resource: "agent",
      resourceId: agent.id,
      before,
      after: agentAuditSnapshot(agent),
    }),
  ]);
  response.json({
    agent,
    routingWarning: "",
  });
}

export async function getDashboardBootstrap(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const [initialAgents, config] = await Promise.all([
    VoiceAgentModel.find({ ownerId: userId }).sort({ createdAt: 1 }),
    cachedDashboardVoiceConfig(userId),
  ]);
  let agents = initialAgents;
  if (agents.length === 0) {
    await ensureStarterAgent(userId);
    agents = await VoiceAgentModel.find({ ownerId: userId }).sort({ createdAt: 1 });
  }
  response.json({
    agents,
    config,
    templates: Object.entries(agentTemplates).map(([id, template]) => ({ id, ...template })),
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
  const userId = ownerId(request);
  const source = await findAgent(request);
  const copy = source.toObject();
  delete (copy as Record<string, unknown>)._id;
  delete (copy as Record<string, unknown>).createdAt;
  delete (copy as Record<string, unknown>).updatedAt;
  const agent = await VoiceAgentModel.create({
    ...copy,
    ownerId: userId,
    name: `${source.name} copy`.slice(0, 80),
    status: "Draft",
    phone: "",
    version: 1,
    latencyMetrics: undefined,
  });
  await invalidateDashboardCache(userId);
  await cloneAgentKnowledge(source._id, agent);
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
  const userId = ownerId(request);
  const template = agentTemplates[request.params.templateId as keyof typeof agentTemplates];
  if (!template) throw new HttpError(404, "Agent template not found.");
  const agent = await VoiceAgentModel.create({
    ownerId: userId,
    ...template,
    status: "Draft",
    phone: "",
    language: "English",
    voice: "alloy",
  });
  await invalidateDashboardCache(userId);
  await recordAuditLog(request, {
    action: "agent.created_from_template",
    resource: "agent",
    resourceId: agent.id,
    after: { ...agentAuditSnapshot(agent), templateId: request.params.templateId },
  });
  response.status(201).json({ agent });
}

export async function deleteAgent(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agent = await findAgent(request);
  if (await PhoneNumberModel.exists({ ownerId: userId, agentId: agent._id })) {
    throw new HttpError(409, "Move or remove this agent's phone numbers before deleting it.");
  }
  const before = agentAuditSnapshot(agent);
  await deleteAgentKnowledge(agent._id);
  await agent.deleteOne();
  await invalidateDashboardCache(userId);
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
  if (requestedPhoneNumberId && !isValidObjectId(requestedPhoneNumberId)) {
    throw new HttpError(400, "Valid phoneNumberId is required.");
  }
  const sourceNumber = await PhoneNumberModel.findOne({
    ownerId: userId,
    agentId: agent._id,
    ...(requestedPhoneNumberId ? { _id: requestedPhoneNumberId } : {}),
    direction: { $in: ["Outbound", "Both"] },
    status: { $in: ["Ready", "Needs setup"] },
    lifecycle: { $ne: "deleting" },
  }).sort({ updatedAt: -1 });

  if (!sourceNumber) {
    throw new HttpError(
      409,
      "Import or buy a Vobiz number with Outbound or Both direction before starting outbound calls.",
    );
  }

  if (!sourceNumber.outboundTrunkId && !env.livekitSipOutboundTrunkId) {
    const credentials = sourceNumber.provider === "Vobiz"
      ? await getVobizCredentials(userId)
      : null;
    const outboundTrunkId = await ensureOutboundTrunkForPhone(
      sourceNumber.provider,
      credentials,
      sourceNumber.number,
      sourceNumber.direction,
    );
    await PhoneNumberModel.updateOne(
      { _id: sourceNumber._id, ownerId: userId, lifecycle: { $ne: "deleting" } },
      {
        $set: {
          outboundTrunkId,
          ...(sourceNumber.direction === "Outbound" ? { status: "Ready" } : {}),
        },
      },
    );
    sourceNumber.outboundTrunkId = outboundTrunkId;
    if (sourceNumber.direction === "Outbound") sourceNumber.status = "Ready";
  }

  const callAdmission = await acquirePhoneNumberCallAdmission(userId, sourceNumber.id);
  try {
    const lockedNumber = callAdmission.phone;
    if (
      String(lockedNumber.agentId ?? "") !== String(agent._id)
      || !["Outbound", "Both"].includes(lockedNumber.direction)
      || !(lockedNumber.outboundTrunkId || env.livekitSipOutboundTrunkId)
    ) {
      throw new HttpError(409, "The selected outbound number changed. Refresh phone numbers before calling.");
    }
    response
      .status(202)
      .json(await startOutboundCall(agent, userId, destination, lockedNumber.number, {
        phoneNumberId: lockedNumber.id,
        callAdmission,
        metadata: widgetMetadata(request.body.metadata),
      }));
  } finally {
    await callAdmission.release().catch((error) => {
      console.error(JSON.stringify({
        event: "outbound-phone-admission-release-failed",
        phoneNumberId: sourceNumber.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }
}

export async function previewVoice(request: AuthenticatedRequest, response: Response) {
  const provider = cleanText(request.body.provider);
  if (!["openai", "gemini", "sarvam", "elevenlabs"].includes(provider)) {
    throw new HttpError(400, "Choose a supported voice provider.");
  }
  const mode = request.body.mode === "pipeline" ? "pipeline" : "realtime";
  const { createVoicePreview } = await import("../services/voicePreviewService.js");
  const audio = await createVoicePreview({
    mode,
    provider: provider as "openai" | "gemini" | "sarvam" | "elevenlabs",
    model: cleanText(request.body.model),
    voice: cleanText(request.body.voice, "alloy"),
    language: cleanText(request.body.language, "English"),
    text: cleanText(request.body.text),
    voiceSpeed: typeof request.body.voiceSpeed === "number" ? request.body.voiceSpeed : undefined,
    voicePitch: typeof request.body.voicePitch === "number" ? request.body.voicePitch : undefined,
  });

  response
    .set({
      "Content-Type": "audio/wav",
      "Content-Length": String(audio.byteLength),
      "Cache-Control": "no-store",
    })
    .send(audio);
}

const marketingVoiceSamples: Record<string, { language: string; text: string }> = {
  hi: { language: "hi-IN", text: "हाँ, डॉक्टर पटेल कल शाम चार बजे उपलब्ध हैं। क्या मैं आपके लिए समय बुक कर दूँ?" },
  en: { language: "en-IN", text: "Yes, Doctor Patel is available tomorrow at four P.M. Shall I book the appointment for you?" },
  ta: { language: "ta-IN", text: "ஆம், டாக்டர் படேல் நாளை மாலை நான்கு மணிக்கு உள்ளார். உங்களுக்காக பதிவு செய்யவா?" },
  te: { language: "te-IN", text: "అవును, డాక్టర్ పటేల్ రేపు సాయంత్రం నాలుగు గంటలకు అందుబాటులో ఉన్నారు. బుక్ చేయనా?" },
  kn: { language: "kn-IN", text: "ಹೌದು, ಡಾಕ್ಟರ್ ಪಟೇಲ್ ನಾಳೆ ಸಂಜೆ ನಾಲ್ಕು ಗಂಟೆಗೆ ಲಭ್ಯವಿದ್ದಾರೆ. ಬುಕ್ ಮಾಡಲೇ?" },
  bn: { language: "bn-IN", text: "হ্যাঁ, ডাক্তার প্যাটেল আগামীকাল বিকেল চারটায় উপলব্ধ আছেন। আমি কি বুক করে দেব?" },
  mr: { language: "mr-IN", text: "हो, डॉक्टर पटेल उद्या संध्याकाळी चार वाजता उपलब्ध आहेत. मी वेळ बुक करू का?" },
  gu: { language: "gu-IN", text: "હા, ડૉક્ટર પટેલ આવતીકાલે સાંજે ચાર વાગ્યે ઉપલબ્ધ છે. શું હું સમય બુક કરું?" },
  pa: { language: "pa-IN", text: "ਹਾਂ, ਡਾਕਟਰ ਪਟੇਲ ਕੱਲ੍ਹ ਸ਼ਾਮ ਚਾਰ ਵਜੇ ਉਪਲਬਧ ਹਨ। ਕੀ ਮੈਂ ਤੁਹਾਡੇ ਲਈ ਸਮਾਂ ਬੁੱਕ ਕਰ ਦਿਆਂ?" },
  ml: { language: "ml-IN", text: "അതെ, ഡോക്ടർ പട്ടേൽ നാളെ വൈകുന്നേരം നാല് മണിക്ക് ലഭ്യമാണ്. ഞാൻ നിങ്ങൾക്കായി സമയം ബുക്ക് ചെയ്യട്ടേ?" },
};

const marketingVoiceCache = new Map<string, Promise<Buffer>>();

async function createSarvamMarketingVoice(sample: { language: string; text: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const apiResponse = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": env.sarvamApiKey },
      body: JSON.stringify({
        text: sample.text,
        target_language_code: sample.language,
        speaker: "kavya",
        model: "bulbul:v3",
        pace: 0.96,
        speech_sample_rate: "24000",
        output_audio_codec: "wav",
      }),
      signal: controller.signal,
    });
    const result = await apiResponse.json() as { audios?: string[]; error?: { message?: string } };
    const encodedAudio = result.audios?.[0];
    if (!apiResponse.ok || !encodedAudio) {
      throw new HttpError(502, result.error?.message || `Sarvam voice preview failed with status ${apiResponse.status}.`);
    }
    return Buffer.from(encodedAudio, "base64");
  } finally {
    clearTimeout(timeout);
  }
}

export async function previewMarketingVoice(request: Request, response: Response) {
  const languageCode = request.params.languageCode?.trim().toLowerCase() ?? "";
  const sample = marketingVoiceSamples[languageCode];
  if (!sample) throw new HttpError(404, "Voice sample not found.");

  let audioPromise = marketingVoiceCache.get(languageCode);
  if (!audioPromise) {
    audioPromise = (async () => {
      const { createVoicePreview } = await import("../services/voicePreviewService.js");
      if (env.sarvamApiKey) {
        try {
          return await createSarvamMarketingVoice(sample);
        } catch (error) {
          if (!env.openaiApiKey) throw error;
        }
      }
      return createVoicePreview({
        mode: "pipeline",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "coral",
        language: sample.language,
        text: sample.text,
        voiceSpeed: 0.96,
      });
    })().catch((error) => {
      marketingVoiceCache.delete(languageCode);
      throw error;
    });
    marketingVoiceCache.set(languageCode, audioPromise);
  }

  const audio = await audioPromise;
  response
    .set({
      "Content-Type": "audio/wav",
      "Content-Length": String(audio.byteLength),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    })
    .send(audio);
}

export async function listPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const numbers = await PhoneNumberModel.find({ ownerId: ownerId(request) })
    .populate("agentId", "_id name")
    .sort({ createdAt: -1 });
  response.json({ numbers });
}

export async function createPhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const number = requireE164(request.body.phoneNumber);
  const provider = telephonyProvider(request.body.provider);
  const reservation = await reservePhoneNumber(userId, number);

  try {
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
      const account = await findVobizOwnedNumberWithAccount({ authId, authToken }, number);
      const verified = account.number;
      await connectVobiz(
        userId,
        { authId, authToken },
        { verifiedOwnedNumberCount: account.total },
      );
      providerNumberId = verified.id;
      providerLabel = `${verified.region || verified.country} Vobiz number`;
      region = [verified.region, verified.country].filter(Boolean).join(", ") || "Vobiz";
    }

    await reservation.assertHeld();
    const phone = await PhoneNumberModel.create({
      ownerId: userId,
      number,
      label: cleanText(request.body.label, providerLabel),
      direction: phoneDirection(request.body.direction),
      region,
      provider,
      providerNumberId,
      status: "Needs setup",
    }).catch((error: unknown) => rethrowPhoneNumberWriteError(error, userId, number));
    await reservation.finalize(phone.id);
    await recordPostCommitAudit(request, {
      action: "phone_number.imported",
      resource: "phone_number",
      resourceId: phone.id,
      after: phoneAuditSnapshot(phone),
    });
    response.status(201).json({ number: phone });
  } finally {
    await reservation.release().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-reservation-release-failed",
        number,
        userId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }
}

export async function assignPhoneNumberAgent(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const phoneMutation = await acquirePhoneNumberMutation(userId, request.params.phoneNumberId);
  const phone = phoneMutation.phone;

  try {
    const before = phoneAuditSnapshot(phone);
    const previousAgentId = phone.agentId ? String(phone.agentId) : "";
    const requestedAgentId = cleanText(request.body.agentId);
    let routingWarning = "";

    if (!requestedAgentId) {
      const routeRemovalAttempted = Boolean(phone.dispatchRuleId || phone.direction !== "Outbound");
      if (routeRemovalAttempted) {
        // Persist a fail-closed state before removing the external route. A
        // later MongoDB transaction failure can no longer leave inbound live.
        await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
        try {
          await phoneMutation.assertHeld();
          await removeInboundRoute(phone.number, userId);
        } catch (error) {
          routingWarning = error instanceof Error ? error.message : String(error);
        }
      }

      try {
        await runMongoTransaction(async (session) => {
          const updated = await phoneMutation.updateLocked(
            {
              $set: {
                agentId: null,
                inboundTrunkId: "",
                outboundTrunkId: "",
                dispatchRuleId: "",
                status: "Needs setup",
              },
            },
            session,
          );
          if (previousAgentId) {
            await VoiceAgentModel.updateOne(
              { _id: previousAgentId, ownerId: userId, phone: phone.number },
              { $set: { phone: "" } },
              { session },
            );
          }
          return String(updated._id);
        });
      } catch (error) {
        if (routeRemovalAttempted) {
          await markPhoneRouteNeedsSetup(phoneMutation, "phone-unassign-route-state-reconcile-failed");
        }
        throw error;
      }
    } else {
      if (!isValidObjectId(requestedAgentId)) {
        throw new HttpError(400, "Invalid agent id.");
      }
      const agent = await VoiceAgentModel.findOne({ _id: requestedAgentId, ownerId: userId });
      if (!agent) throw new HttpError(404, "Voice agent not found.");

      let dispatchRuleId = "";
      let inboundTrunkId = "";
      let outboundTrunkId = "";
      let routeReady = phone.direction === "Outbound";
      let routeChange: Awaited<ReturnType<typeof createInboundRoute>> | null = null;

      if (phone.direction !== "Outbound") {
        // Block inbound admission before changing a LiveKit rule. The final
        // transaction is the only step that makes the replacement Ready.
        await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
      }

      try {
        if (phone.provider === "Vobiz") {
          const credentials = await getVobizCredentials(userId);
          outboundTrunkId = await ensureOutboundTrunkForPhone(
            phone.provider,
            credentials,
            phone.number,
            phone.direction,
          );
          if (phone.direction === "Outbound") {
            await findVobizOwnedNumber(credentials, phone.number);
          } else {
            const route = await activateVobizInboundRoute(
              credentials,
              agent,
              phone.number,
              phoneMutation.token,
              phone.dispatchRuleId,
              phoneMutation.assertHeld,
            );
            dispatchRuleId = route.dispatchRuleId;
            inboundTrunkId = route.inboundTrunkId;
            routeChange = route.routeChange;
          }
        } else if (phone.direction !== "Outbound") {
          outboundTrunkId = await ensureOutboundTrunkForPhone(
            phone.provider,
            null,
            phone.number,
            phone.direction,
          );
          await phoneMutation.assertHeld();
          const created = await createInboundRoute(
            agent,
            phone.number,
            phoneMutation.token,
            phone.dispatchRuleId,
          );
          routeChange = created;
          const rule = created.route;
          dispatchRuleId = rule.sipDispatchRuleId;
          if (!dispatchRuleId) {
            throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
          }
          inboundTrunkId = rule.trunkIds[0] ?? "";
        } else {
          outboundTrunkId = await ensureOutboundTrunkForPhone(
            phone.provider,
            null,
            phone.number,
            phone.direction,
          );
        }
        routeReady =
          (phone.direction === "Outbound" || Boolean(dispatchRuleId)) &&
          (phone.direction === "Inbound" || Boolean(outboundTrunkId));
      } catch (error) {
        if (routeChange) {
          await rollbackInboundRoute(routeChange).catch((cleanupError) => {
            console.error(JSON.stringify({
              event: "phone-assign-route-setup-compensation-failed",
              phoneNumberId: phone.id,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }));
          });
          routeChange = null;
        }
        routingWarning = error instanceof Error ? error.message : String(error);
        dispatchRuleId = "";
        inboundTrunkId = "";
        routeReady = false;
      }

      try {
        await runMongoTransaction(async (session) => {
          const updated = await phoneMutation.updateLocked(
            {
              $set: {
                agentId: agent._id,
                dispatchRuleId,
                inboundTrunkId: dispatchRuleId ? inboundTrunkId : "",
                outboundTrunkId,
                status: routeReady ? "Ready" : "Needs setup",
              },
            },
            session,
          );
          if (previousAgentId && previousAgentId !== requestedAgentId) {
            await VoiceAgentModel.updateOne(
              { _id: previousAgentId, ownerId: userId, phone: phone.number },
              { $set: { phone: "" } },
              { session },
            );
          }
          const assigned = await VoiceAgentModel.updateOne(
            { _id: agent._id, ownerId: userId },
            { $set: { phone: phone.number } },
            { session },
          );
          if (assigned.matchedCount !== 1) {
            throw new HttpError(409, "The selected agent changed while the phone number was being assigned.");
          }
          return String(updated._id);
        });
      } catch (error) {
        if (routeChange) {
          await rollbackInboundRoute(routeChange).catch((cleanupError) => {
            console.error(JSON.stringify({
              event: "phone-assign-route-compensation-failed",
              phoneNumberId: phone.id,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }));
          });
        }
        if (phone.direction !== "Outbound") {
          await markPhoneRouteNeedsSetup(phoneMutation, "phone-assign-route-state-reconcile-failed");
        }
        throw error;
      }

      if (routeChange) {
        await phoneMutation.assertHeld()
          .then(() => finalizeInboundRoute(routeChange))
          .catch((cleanupError) => {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            routingWarning = [routingWarning, `The new route is active, but old-route cleanup needs a sync: ${message}`]
              .filter(Boolean)
              .join(" ");
            console.error(JSON.stringify({
              event: "phone-assign-stale-route-cleanup-failed",
              phoneNumberId: phone.id,
              error: message,
            }));
          });
      }
    }

    await invalidateDashboardCache(userId);
    const populated = await PhoneNumberModel.findOne({
      _id: phone._id,
      ownerId: userId,
      lifecycle: { $ne: "deleting" },
    }).populate<{ agentId: VoiceAgentDocument | null }>("agentId");
    if (!populated) {
      throw new HttpError(409, "The phone number changed while its assignment was being returned.");
    }
    await recordPostCommitAudit(request, {
      action: requestedAgentId ? "phone_number.agent_assigned" : "phone_number.agent_unassigned",
      resource: "phone_number",
      resourceId: populated.id,
      before,
      after: phoneAuditSnapshot(populated),
    });
    response.json({ number: populated, routingWarning });
  } finally {
    await phoneMutation.release().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-mutation-release-failed",
        phoneNumberId: request.params.phoneNumberId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }
}

export async function deletePhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const phoneMutation = await acquirePhoneNumberMutation(
    userId,
    request.params.phoneNumberId,
    { deleting: true },
  );
  const phone = phoneMutation.phone;

  try {
    const before = phoneAuditSnapshot(phone);
    const warnings: string[] = [];
    const previousAgentId = phone.agentId ? String(phone.agentId) : "";

    const activeCall = await CallDetailRecordModel.exists({
      ownerId: userId,
      status: { $in: ["initiated", "ringing", "active"] },
      $or: [
        { phoneNumberId: phone._id },
        { direction: "inbound", calledNumber: phone.number },
        { direction: "outbound", callerNumber: phone.number },
      ],
    });
    if (activeCall) {
      await phoneMutation.cancelDelete();
      throw new HttpError(
        409,
        "This number has an active call. End the call and pause any campaign using it before deleting.",
      );
    }

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

    await runMongoTransaction(async (session) => {
      if (previousAgentId) {
        await VoiceAgentModel.updateOne(
          { _id: previousAgentId, ownerId: userId, phone: phone.number },
          { $set: { phone: "" } },
          { session },
        );
      }
      await releasePhoneNumberOwnership(userId, phone.number, phone.id, session);
      await phoneMutation.deleteLocked(session);
      return phone.id;
    });
    phoneMutation.complete();
    await invalidateDashboardCache(userId);
    await recordPostCommitAudit(request, {
      action: "phone_number.deleted",
      resource: "phone_number",
      resourceId: phone.id,
      before,
      after: {},
    });

    response.json({ deleted: true, routingWarning: warnings.join(" ") });
  } finally {
    await phoneMutation.release().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-delete-lease-release-failed",
        phoneNumberId: request.params.phoneNumberId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }
}

async function saveVobizRoute(input: {
  userId: string;
  agent: VoiceAgentDocument;
  credentials: VobizCredentials;
  number: VobizNumber;
  label?: string;
  direction: "Inbound" | "Outbound" | "Both";
  reservation: PhoneNumberReservationLease;
}) {
  await input.reservation.assertHeld();
  const pendingPhone = await PhoneNumberModel.create({
    ownerId: input.userId,
    number: input.number.e164,
    label: cleanText(input.label, `${input.agent.name} line`),
    direction: input.direction,
    region: [input.number.region, input.number.country].filter(Boolean).join(", ") || "Vobiz",
    agentId: null,
    inboundTrunkId: "",
    outboundTrunkId: "",
    dispatchRuleId: "",
    provider: "Vobiz",
    providerNumberId: input.number.id,
    monthlyFee: input.number.monthly_fee ?? 0,
    currency: input.number.currency ?? "INR",
    status: "Needs setup",
    lifecycle: "active",
    mutationToken: input.reservation.token,
    mutationExpiresAt: phoneNumberMutationLeaseExpiry(),
  }).catch((error: unknown) => rethrowPhoneNumberWriteError(error, input.userId, input.number.e164));
  const phoneMutation = await adoptPhoneNumberMutation(
    input.userId,
    pendingPhone.id,
    input.reservation.token,
  );
  await input.reservation.finalize(pendingPhone.id);

  let dispatchRuleId = "";
  let databaseCommitted = false;
  let routeChange: Awaited<ReturnType<typeof createInboundRoute>> | null = null;
  try {
    let inboundTrunkId = "";
    const outboundTrunkId = await ensureOutboundTrunkForPhone(
      "Vobiz",
      input.credentials,
      input.number.e164,
      input.direction,
    );
    if (input.direction !== "Outbound") {
      const route = await activateVobizInboundRoute(
        input.credentials,
        input.agent,
        input.number.e164,
        phoneMutation.token,
        pendingPhone.dispatchRuleId,
        phoneMutation.assertHeld,
      );
      routeChange = route.routeChange;
      dispatchRuleId = route.dispatchRuleId;
      inboundTrunkId = route.inboundTrunkId;
    }

    await runMongoTransaction(async (session) => {
      const updated = await phoneMutation.updateLocked(
        {
          $set: {
            agentId: input.agent._id,
            inboundTrunkId: input.direction === "Outbound" ? "" : inboundTrunkId,
            outboundTrunkId,
            dispatchRuleId,
            status: "Ready",
          },
        },
        session,
      );
      const assigned = await VoiceAgentModel.updateOne(
        { _id: input.agent._id, ownerId: input.userId },
        { $set: { phone: input.number.e164 } },
        { session },
      );
      if (assigned.matchedCount !== 1) {
        throw new HttpError(409, "The selected agent changed while routing was being configured.");
      }
      return String(updated._id);
    });
    databaseCommitted = true;

    if (routeChange) {
      const committedRouteChange = routeChange;
      await phoneMutation.assertHeld()
        .then(() => finalizeInboundRoute(committedRouteChange))
        .catch((cleanupError) => {
          console.error(JSON.stringify({
            event: "phone-import-stale-route-cleanup-failed",
            phoneNumberId: pendingPhone.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }));
        });
    }

    await invalidateDashboardCache(input.userId);
    const phone = await PhoneNumberModel.findOne({
      _id: pendingPhone._id,
      ownerId: input.userId,
      lifecycle: { $ne: "deleting" },
    }).populate<{ agentId: VoiceAgentDocument }>("agentId");
    if (!phone) {
      throw new HttpError(409, "The phone number changed while routing was being configured.");
    }
    return phone;
  } catch (error) {
    if (!databaseCommitted && routeChange) {
      await rollbackInboundRoute(routeChange).catch((cleanupError) => {
        console.error(JSON.stringify({
          event: "phone-import-route-compensation-failed",
          phoneNumberId: pendingPhone.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }));
      });
    }
    throw error;
  } finally {
    await phoneMutation.release().catch(() => undefined);
  }
}

async function activateVobizInboundRoute(
  credentials: VobizCredentials,
  agent: VoiceAgentDocument,
  phoneNumber: string,
  mutationId: string,
  preferredDispatchRuleId: string,
  assertMutationHeld: () => Promise<void>,
) {
  await configureVobizLiveKitInbound(credentials, phoneNumber);
  await assertMutationHeld();
  const routeChange = await createInboundRoute(
    agent,
    phoneNumber,
    mutationId,
    preferredDispatchRuleId,
  );
  const rule = routeChange.route;
  const dispatchRuleId = rule.sipDispatchRuleId;
  if (!dispatchRuleId) {
    await rollbackInboundRoute(routeChange).catch(() => undefined);
    throw new HttpError(502, "LiveKit did not return an inbound dispatch rule id.");
  }
  return {
    routeChange,
    dispatchRuleId,
    inboundTrunkId: rule.trunkIds[0] ?? "",
  };
}

export async function activateInboundPhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  if (!isValidObjectId(request.params.phoneNumberId)) {
    throw new HttpError(400, "Invalid phone number id.");
  }

  const phoneMutation = await acquirePhoneNumberMutation(userId, request.params.phoneNumberId);
  const existing = phoneMutation.phone;

  try {
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
    const previousAgentId = existing.agentId ? String(existing.agentId) : "";
    const label = cleanText(request.body.label);
    const credentials = await getVobizCredentials(userId);
    const nextDirection = requestedDirection ?? (existing.direction === "Outbound" ? "Both" : existing.direction);
    await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
    let route: Awaited<ReturnType<typeof activateVobizInboundRoute>>;
    let outboundTrunkId = "";
    try {
      outboundTrunkId = await ensureOutboundTrunkForPhone(
        existing.provider,
        credentials,
        existing.number,
        nextDirection,
      );
      route = await activateVobizInboundRoute(
        credentials,
        agent,
        existing.number,
        phoneMutation.token,
        existing.dispatchRuleId,
        phoneMutation.assertHeld,
      );
    } catch (error) {
      await markPhoneRouteNeedsSetup(
        phoneMutation,
        "phone-activation-route-setup-reconcile-failed",
      );
      throw error;
    }

    try {
      await runMongoTransaction(async (session) => {
        const updated = await phoneMutation.updateLocked(
          {
            $set: {
              agentId: agent._id,
              direction: nextDirection,
              label: label || existing.label,
              inboundTrunkId: route.inboundTrunkId,
              outboundTrunkId,
              dispatchRuleId: route.dispatchRuleId,
              status: "Ready",
            },
          },
          session,
        );
        if (previousAgentId && previousAgentId !== agentId) {
          await VoiceAgentModel.updateOne(
            { _id: previousAgentId, ownerId: userId, phone: existing.number },
            { $set: { phone: "" } },
            { session },
          );
        }
        const assigned = await VoiceAgentModel.updateOne(
          { _id: agent._id, ownerId: userId },
          { $set: { phone: existing.number } },
          { session },
        );
        if (assigned.matchedCount !== 1) {
          throw new HttpError(409, "The selected agent changed while inbound routing was being activated.");
        }
        return String(updated._id);
      });
    } catch (error) {
      await rollbackInboundRoute(route.routeChange).catch((cleanupError) => {
        console.error(JSON.stringify({
          event: "phone-activation-route-compensation-failed",
          phoneNumberId: existing.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }));
      });
      await markPhoneRouteNeedsSetup(
        phoneMutation,
        "phone-activation-route-state-reconcile-failed",
      );
      throw error;
    }

    let routingWarning = "";
    await phoneMutation.assertHeld()
      .then(() => finalizeInboundRoute(route.routeChange))
      .catch((cleanupError) => {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        routingWarning = `The inbound route is active, but old-route cleanup needs a sync: ${message}`;
        console.error(JSON.stringify({
          event: "phone-activation-stale-route-cleanup-failed",
          phoneNumberId: existing.id,
          error: message,
        }));
      });

    await invalidateDashboardCache(userId);
    const phone = await PhoneNumberModel.findOne({
      _id: existing._id,
      ownerId: userId,
      lifecycle: { $ne: "deleting" },
    }).populate<{ agentId: VoiceAgentDocument }>("agentId");
    if (!phone) {
      throw new HttpError(409, "The phone number changed while inbound routing was being returned.");
    }
    await recordPostCommitAudit(request, {
      action: "phone_number.inbound_activated",
      resource: "phone_number",
      resourceId: String(phone._id),
      before,
      after: phoneAuditSnapshot(phone),
    });
    response.json({ number: phone, routingWarning });
  } finally {
    await phoneMutation.release().catch(() => undefined);
  }
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
  const reservation = await reservePhoneNumber(userId, requestedNumber);

  try {
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
      reservation,
    });
    if (!phone) throw new HttpError(500, "The imported phone number could not be saved.");
    await reservation.finalize(String(phone._id));
    await recordPostCommitAudit(request, {
      action: "phone_number.imported",
      resource: "phone_number",
      resourceId: String(phone._id),
      after: phoneAuditSnapshot(phone),
    });
    response.status(201).json({ number: phone });
  } finally {
    await reservation.release().catch(() => undefined);
  }
}

export async function purchasePhoneNumber(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const requestedNumber = requireE164(request.body.phoneNumber);
  const reservation = await reservePhoneNumber(userId, requestedNumber, { operation: "purchase" });

  try {
    const credentials = await getVobizCredentials(userId);
    let vobizNumber = reservation.purchaseRecovery === "confirmed"
      ? recoveredVobizNumber(reservation.confirmedProviderNumber, requestedNumber)
      : null;

    if (!vobizNumber && reservation.purchaseRecovery !== "none") {
      try {
        vobizNumber = await findVobizOwnedNumber(credentials, requestedNumber);
      } catch (error) {
        if (!(error instanceof HttpError) || error.statusCode !== 404) {
          await reservation.markPurchaseUnconfirmed().catch(() => undefined);
          if (error instanceof HttpError && error.statusCode === 400) throw error;
          throw new VobizPurchaseUnconfirmedError();
        }
      }
    }

    if (!vobizNumber) {
      await reservation.assertHeld();
      await reservation.beginPurchaseAttempt();
      try {
        vobizNumber = await purchaseVobizNumber(
          credentials,
          requestedNumber,
          cleanText(request.body.currency),
          reservation.idempotencyKey,
        );
      } catch (error) {
        if (error instanceof VobizPurchaseUnconfirmedError) {
          await reservation.markPurchaseUnconfirmed().catch(() => undefined);
        } else if (
          error instanceof HttpError
          && [400, 404, 409, 422].includes(error.statusCode)
        ) {
          await reservation.markPurchaseFailed().catch(() => undefined);
        }
        throw error;
      }
    }

    await reservation.markPurchaseConfirmed(vobizNumber as unknown as Record<string, unknown>);
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
          reservation,
        })
      : await (async () => {
          await reservation.assertHeld();
          return PhoneNumberModel.create({
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
          }).catch((error: unknown) => rethrowPhoneNumberWriteError(error, userId, requestedNumber));
        })();
    if (!phone) throw new HttpError(500, "The purchased phone number could not be saved.");
    await reservation.finalize(String(phone._id));
    await recordPostCommitAudit(request, {
      action: "phone_number.purchased",
      resource: "phone_number",
      resourceId: String(phone._id),
      after: phoneAuditSnapshot(phone),
    });
    response.status(201).json({ number: phone });
  } catch (error) {
    if (error instanceof VobizPurchaseUnconfirmedError) {
      await reservation.markPurchaseUnconfirmed().catch(() => undefined);
    }
    throw error;
  } finally {
    await reservation.release().catch(() => undefined);
  }
}

export async function syncPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const credentials = await getVobizCredentials(userId);
  const [vobiz, routes] = await Promise.all([
    listVobizOwnedNumbers(credentials),
    PhoneNumberModel.find({ ownerId: userId, provider: "Vobiz", lifecycle: { $ne: "deleting" } }).select("_id number"),
  ]);

  let repaired = 0;
  let needsSetup = 0;
  const errors: { number: string; message: string }[] = [];

  for (const listedRoute of routes) {
    let phoneMutation;
    try {
      phoneMutation = await acquirePhoneNumberMutation(userId, String(listedRoute._id));
    } catch (error) {
      errors.push({
        number: listedRoute.number,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const route = await phoneMutation.phone.populate<{ agentId: VoiceAgentDocument | null }>("agentId");
    try {
      if (route.direction === "Outbound") {
        const outboundTrunkId = await ensureOutboundTrunkForPhone(
          route.provider,
          credentials,
          route.number,
          route.direction,
        );
        await phoneMutation.updateLocked({
          $set: {
            outboundTrunkId,
            status: outboundTrunkId ? "Ready" : "Needs setup",
          },
        });
        repaired += 1;
        continue;
      }

      if (!route.agentId) {
        await phoneMutation.updateLocked({
          $set: {
            status: "Needs setup",
            inboundTrunkId: "",
            dispatchRuleId: "",
          },
        });
        needsSetup += 1;
        errors.push({ number: route.number, message: "Assign an agent before creating an inbound route." });
        continue;
      }

      let routeChange: Awaited<ReturnType<typeof createInboundRoute>> | null = null;
      try {
        await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
        const inboundRoute = await activateVobizInboundRoute(
          credentials,
          route.agentId,
          route.number,
          phoneMutation.token,
          route.dispatchRuleId,
          phoneMutation.assertHeld,
        );
        routeChange = inboundRoute.routeChange;
        const outboundTrunkId = await ensureOutboundTrunkForPhone(
          route.provider,
          credentials,
          route.number,
          route.direction,
        );
        await phoneMutation.updateLocked({
          $set: {
            inboundTrunkId: inboundRoute.inboundTrunkId,
            outboundTrunkId,
            dispatchRuleId: inboundRoute.dispatchRuleId,
            status: "Ready",
          },
        });
        repaired += 1;
        await phoneMutation.assertHeld()
          .then(() => finalizeInboundRoute(inboundRoute.routeChange))
          .catch((cleanupError) => {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            errors.push({
              number: route.number,
              message: `Route repaired, but stale-route cleanup failed: ${message}`,
            });
            console.error(JSON.stringify({
              event: "phone-sync-stale-route-cleanup-failed",
              phoneNumberId: route.id,
              error: message,
            }));
          });
      } catch (error) {
        if (routeChange) {
          await rollbackInboundRoute(routeChange).catch((cleanupError) => {
            console.error(JSON.stringify({
              event: "phone-sync-route-compensation-failed",
              phoneNumberId: route.id,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }));
          });
        }
        await phoneMutation.updateLocked({
          $set: {
            status: "Needs setup",
            inboundTrunkId: "",
            outboundTrunkId: "",
            dispatchRuleId: "",
          },
        }).catch(() => undefined);
        needsSetup += 1;
        errors.push({
          number: route.number,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await phoneMutation.release().catch(() => undefined);
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
