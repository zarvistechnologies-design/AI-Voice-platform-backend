import type { Request, Response } from "express";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import { acquirePhoneNumberCallAdmission } from "../services/phoneNumberCallAdmissionService.js";
import { startOutboundCall, createWebCallToken } from "../services/livekitService.js";
import { defaultGeminiRealtimeModel } from "../services/modelCatalog.js";
import { normalizeE164 } from "../utils/phoneNumber.js";
import { HttpError } from "../utils/httpError.js";
import { DEMO_SCENARIOS, DEMO_LANGUAGES, getScenario } from "../config/demoScenarios.js";

import { env } from "../config/env.js";

const PREFERRED_DEMO_NUMBER = "+918044318955";

function cleanText(value: unknown, maxLength = 100): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

async function getOrCreateDemoAgent(ownerId: string): Promise<VoiceAgentDocument> {
  let agent = await VoiceAgentModel.findOne({
    ownerId,
    name: "Interactive Demo Agent",
  });

  if (!agent) {
    agent = await VoiceAgentModel.create({
      ownerId,
      name: "Interactive Demo Agent",
      team: "Product Showcase",
      status: "Live",
      language: "English",
      supportedLanguages: ["English", "Hindi"],
      multilingualEnabled: true,
      voice: "Puck",
      pipelineMode: "realtime",
      realtimeProvider: "gemini",
      realtimeModel: defaultGeminiRealtimeModel,
      firstMessage: "Hello! How can I help you today?",
      prompt: "You are a versatile, polite, and helpful realtime voice assistant. Speak concisely and naturally.",
      tools: [],
    });
  }

  return agent;
}

export async function getDemoScenariosConfig(_request: Request, response: Response) {
  response.json({
    scenarios: DEMO_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
      team: scenario.team,
    })),
    languages: DEMO_LANGUAGES,
    defaultModel: defaultGeminiRealtimeModel,
  });
}

export async function initiateDemoCall(request: Request, response: Response) {
  const name = cleanText(request.body?.name, 80);
  const rawPhone = request.body?.phoneNumber;
  const scenarioId = cleanText(request.body?.scenarioId, 50);
  const language = cleanText(request.body?.language, 40) || "English";

  const destination = normalizeE164(rawPhone);
  if (!destination) {
    throw new HttpError(
      400,
      "Please enter a valid phone number with country code, e.g. +91 9876543210 or +1 2525550123.",
    );
  }

  const scenario = getScenario(scenarioId);

  // Look for the preferred demo number (+918071584457) or any active outbound number
  let sourceNumber = await PhoneNumberModel.findOne({
    number: PREFERRED_DEMO_NUMBER,
    lifecycle: { $ne: "deleting" },
  });

  if (!sourceNumber) {
    sourceNumber = await PhoneNumberModel.findOne({
      direction: { $in: ["Outbound", "Both"] },
      status: "Ready",
      lifecycle: { $ne: "deleting" },
    }).sort({ updatedAt: -1 });
  }

  // If +918071584457 is not in DB yet, auto-provision it using existing owner or fallback
  if (!sourceNumber) {
    const existingPhone = await PhoneNumberModel.findOne().sort({ createdAt: 1 });
    const defaultOwnerId = existingPhone?.ownerId || "platform-owner";
    sourceNumber = await PhoneNumberModel.create({
      ownerId: defaultOwnerId,
      number: PREFERRED_DEMO_NUMBER,
      label: "Exotel Outbound Virtual Number",
      direction: "Both",
      status: "Ready",
      provider: "Exotel",
      outboundTrunkId: env.exotelSipOutboundTrunkId || "ST_f8b2F6t469mC",
    });
  }

  if (sourceNumber.status !== "Ready") {
    sourceNumber.status = "Ready";
    sourceNumber.direction = "Both";
    if (!sourceNumber.outboundTrunkId) {
      sourceNumber.outboundTrunkId = env.exotelSipOutboundTrunkId || "ST_f8b2F6t469mC";
    }
    await sourceNumber.save();
  }

  const ownerId = sourceNumber.ownerId;

  // Resolve or create the demo voice agent
  let agent: VoiceAgentDocument | null = null;
  if (sourceNumber.agentId) {
    agent = await VoiceAgentModel.findOne({ _id: sourceNumber.agentId, ownerId });
  }

  if (!agent) {
    agent = await getOrCreateDemoAgent(ownerId);
    sourceNumber.agentId = agent._id;
    await sourceNumber.save();
  }

  // Always default to female persona as instructed
  const gender = cleanText(request.body?.gender, 10).toLowerCase();
  const isFemale = gender === "male" ? false : true;
  const persona = isFemale ? scenario.femalePersona : scenario.malePersona;
  const geminiVoice = isFemale ? "Aoede" : "Puck";

  // Personalize prompt and greeting for this specific persona, language, and user name
  const personalizedGreeting = persona.firstMessage(name, language);
  const systemPrompt = `${persona.defaultPrompt}

CRITICAL RULES:
- Primary Language: ${language}. You must conduct the entire conversation naturally, politely, and fluently in ${language}.
- Persona: You are ${persona.name}, speaking with a warm, professional female voice persona.
- When speaking in Hindi or other Indian languages, always use female grammatical forms (e.g., in Hindi: "कर रही हूँ", "सकती हूँ", "बताती हूँ", "भेज दूँगी").
- Caller's Name: ${name || "Customer"}. Greet them respectfully.
- EXPERT DOMAIN KNOWLEDGE: You are a genuine senior advisor. Confidently answer all questions about pricing, specifications, amenities, location, discounts, financing, and schedules using the details in your prompt. Never hesitate or give vague answers.
- VOICE OPTIMIZED: Keep turns concise (1 to 3 clear, natural spoken sentences per turn) so it feels like a real, lively phone conversation. Never speak in long essays, and never use markdown asterisks, hashes, or bullet points.
- PROACTIVE ENGAGEMENT: Answer the user's specific inquiry directly, then ask a relevant next question (e.g. asking their budget, offering a site visit, or offering to send details on WhatsApp).`;

  agent.voice = geminiVoice;
  agent.prompt = systemPrompt;
  agent.firstMessage = personalizedGreeting;
  agent.language = language;
  agent.supportedLanguages = [language, "English"];
  agent.pipelineMode = "realtime";
  agent.realtimeProvider = "gemini";
  agent.realtimeModel = defaultGeminiRealtimeModel;
  agent.status = "Live";
  await agent.save();

  // Acquire admission lease for the phone number
  const callAdmission = await acquirePhoneNumberCallAdmission(ownerId, sourceNumber.id);

  try {
    const lockedNumber = callAdmission.phone;
    if (
      lockedNumber.status !== "Ready" ||
      !["Outbound", "Both"].includes(lockedNumber.direction)
    ) {
      throw new HttpError(409, "The virtual phone number is currently busy or updating. Please try again in a moment.");
    }

    const result = await startOutboundCall(agent, ownerId, destination, lockedNumber.number, {
      phoneNumberId: lockedNumber.id,
      callAdmission,
      telephonyProvider: lockedNumber.provider,
      outboundTrunkId: lockedNumber.outboundTrunkId,
      metadata: {
        RecipientName: name,
        ScenarioId: scenario.id,
        ScenarioLabel: scenario.label,
        Language: language,
        Source: "website_demo_widget",
      },
    });

    response.status(202).json({
      success: true,
      message: `Call initiated! Your phone (${destination}) will ring shortly.`,
      callerNumber: lockedNumber.number,
      scenario: scenario.label,
      ...result,
    });
  } finally {
    await callAdmission.release().catch((error) => {
      console.error(
        JSON.stringify({
          event: "demo-outbound-admission-release-failed",
          phoneNumberId: sourceNumber.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
}

export async function createDemoWebToken(request: Request, response: Response) {
  const name = cleanText(request.body?.name, 80);
  const scenarioId = cleanText(request.body?.scenarioId, 50);
  const language = cleanText(request.body?.language, 40) || "English";

  const scenario = getScenario(scenarioId);

  // Find any active phone number or platform owner to anchor the demo agent
  const sourceNumber = await PhoneNumberModel.findOne({
    status: "Ready",
    lifecycle: { $ne: "deleting" },
  }).sort({ updatedAt: -1 });

  const ownerId = sourceNumber?.ownerId || "platform-demo";
  const agent = await getOrCreateDemoAgent(ownerId);

  const gender = cleanText(request.body?.gender, 10).toLowerCase();
  const isFemale = gender === "male" ? false : true;
  const persona = isFemale ? scenario.femalePersona : scenario.malePersona;
  const geminiVoice = isFemale ? "Aoede" : "Puck";

  const personalizedGreeting = persona.firstMessage(name, language);
  const systemPrompt = `${persona.defaultPrompt}

CRITICAL RULES:
- Primary Language: ${language}. You must conduct the entire conversation naturally, politely, and fluently in ${language}.
- Persona: You are ${persona.name}, speaking with a warm, professional female voice persona.
- When speaking in Hindi or other Indian languages, always use female grammatical forms (e.g., in Hindi: "कर रही हूँ", "सकती हूँ", "बताती हूँ", "भेज दूँगी").
- Mode: Browser Web Voice Call.
- Caller Name: ${name || "Website Visitor"}.
- EXPERT DOMAIN KNOWLEDGE: You are a genuine senior advisor. Confidently answer all questions about pricing, specifications, amenities, location, discounts, financing, and schedules using the details in your prompt. Never hesitate or give vague answers.
- VOICE OPTIMIZED: Keep turns concise (1 to 3 clear, natural spoken sentences per turn) so it feels like a real, lively phone conversation. Never speak in long essays, and never use markdown asterisks, hashes, or bullet points.
- PROACTIVE ENGAGEMENT: Answer the user's specific inquiry directly, then ask a relevant next question (e.g. asking their budget, offering a site visit, or offering to send details on WhatsApp).`;

  agent.voice = geminiVoice;
  agent.prompt = systemPrompt;
  agent.firstMessage = personalizedGreeting;
  agent.language = language;
  agent.supportedLanguages = [language, "English"];
  agent.pipelineMode = "realtime";
  agent.realtimeProvider = "gemini";
  agent.realtimeModel = defaultGeminiRealtimeModel;
  agent.status = "Live";
  await agent.save();

  const tokenData = await createWebCallToken(agent, ownerId, {
    participantName: name || "Website Visitor",
    metadata: {
      RecipientName: name,
      ScenarioId: scenario.id,
      ScenarioLabel: scenario.label,
      Language: language,
      Source: "website_demo_record_voice",
    },
  });

  response.json({
    success: true,
    scenario: scenario.label,
    language,
    ...tokenData,
  });
}
