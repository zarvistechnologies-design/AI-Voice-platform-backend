import type { Response } from "express";

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
  createWebCallToken,
  livekitConfiguration,
  startOutboundCall,
} from "../services/livekitService.js";
import {
  connectVobiz,
  disconnectVobiz,
  getVobizCredentials,
  getVobizIntegration,
} from "../services/integrationService.js";
import {
  findVobizOwnedNumber,
  listVobizInventory,
  listVobizOwnedNumbers,
  purchaseVobizNumber,
  type VobizNumber,
} from "../services/vobizService.js";
import { HttpError } from "../utils/httpError.js";

function ownerId(request: AuthenticatedRequest) {
  if (!request.user) {
    throw new HttpError(401, "Authentication required.");
  }
  return request.user.id;
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
  response.status(201).json({ agent });
}

export async function updateAgent(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
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
  await agent.save();
  response.json({ agent });
}

export async function createWebToken(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  response.json(await createWebCallToken(agent, ownerId(request)));
}

export async function createOutboundCall(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const agent = await findAgent(request);
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

export async function listPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const numbers = await PhoneNumberModel.find({ ownerId: ownerId(request) })
    .populate<{ agentId: VoiceAgentDocument }>("agentId")
    .sort({ createdAt: -1 });
  response.json({ numbers });
}

async function saveVobizRoute(input: {
  userId: string;
  agent: VoiceAgentDocument;
  number: VobizNumber;
  label?: string;
  direction: "Inbound" | "Outbound" | "Both";
}) {
  let dispatchRuleId = "";
  if (input.direction !== "Outbound") {
    const rule = await createInboundRoute(input.agent, input.number.e164);
    dispatchRuleId = rule.sipDispatchRuleId;
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
    number: vobizNumber,
    label: request.body.label,
    direction: phoneDirection(request.body.direction),
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
    number: vobizNumber,
    label: request.body.label,
    direction: phoneDirection(request.body.direction),
  });
  response.status(201).json({ number: phone });
}

export async function syncPhoneNumbers(request: AuthenticatedRequest, response: Response) {
  const userId = ownerId(request);
  const credentials = await getVobizCredentials(userId);
  const [vobiz, routeCount] = await Promise.all([
    listVobizOwnedNumbers(credentials),
    PhoneNumberModel.countDocuments({ ownerId: userId }),
  ]);
  response.json({ vobiz, routes: { total: routeCount } });
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
  response.status(204).end();
}
