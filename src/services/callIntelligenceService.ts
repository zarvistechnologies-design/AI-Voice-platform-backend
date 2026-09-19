import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import {
  normalizeGeminiRealtimeModel,
  normalizeOpenAIRealtimeModel,
} from "./modelCatalog.js";
import { calculateCallCost } from "./modelPricingService.js";

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeRealtimeModel(provider: string, model: string) {
  if (provider === "gemini") return normalizeGeminiRealtimeModel(model);
  if (provider === "openai") return normalizeOpenAIRealtimeModel(model);
  return model;
}

function localAnalysis(transcript: string) {
  const text = transcript.toLowerCase();
  const positive = ["thank", "great", "helpful", "perfect", "yes", "resolved", "excellent"].filter((word) => text.includes(word)).length;
  const negative = ["angry", "bad", "problem", "cancel", "frustrated", "no", "failed", "complaint"].filter((word) => text.includes(word)).length;
  const score = Math.max(-1, Math.min(1, (positive - negative) / Math.max(2, positive + negative)));
  const tags = [
    ...(text.includes("appointment") || text.includes("book") ? ["appointment"] : []),
    ...(text.includes("price") || text.includes("cost") || text.includes("billing") ? ["billing"] : []),
    ...(text.includes("support") || text.includes("problem") ? ["support"] : []),
    ...(text.includes("cancel") ? ["cancellation"] : []),
  ];
  return {
    score: Math.round(score * 100) / 100,
    label: score > 0.2 ? "positive" : score < -0.2 ? "negative" : "neutral",
    tags,
  } as const;
}

async function aiAnalysis(transcript: string) {
  if (!env.enablePostCallAiAnalysis || !env.openaiApiKey) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return JSON only with sentimentScore from -1 to 1, sentimentLabel positive|neutral|negative, and tags as a short string array." },
          { role: "user", content: transcript.slice(0, 30000) },
        ],
      }),
    });
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    if (!response.ok) return null;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as {
      sentimentScore?: number;
      sentimentLabel?: "positive" | "neutral" | "negative";
      tags?: string[];
    };
    if (!Number.isFinite(parsed.sentimentScore) || !parsed.sentimentLabel) return null;
    return {
      score: Math.max(-1, Math.min(1, Number(parsed.sentimentScore))),
      label: parsed.sentimentLabel,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 10) : [],
    };
  } catch {
    return null;
  }
}

type ExtractionField = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date" | "enum";
  description?: string;
  required?: boolean;
  options?: string[];
};

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().slice(0, 240);
  }
  return "";
}

export function inferOutcome(text: string, options: string[] = []) {
  const normalized = text.toLowerCase();
  const candidates = [
    [/(not interested|do not call|don't call|stop calling|unsubscribe|opt out|interested nahi|dilchaspi nahi|call mat|dubara call (?:mat|nahi)|दिलचस्पी नहीं|फोन मत|कॉल मत)/, "not_interested"],
    [/(booking failed|appointment failed|could not book|unable to book)/, "follow_up"],
    [/(voicemail|missed|no answer|not available)/, "missed"],
    [/(call back|follow up|later|tomorrow|next week|kal baat|baad mein|baad me|phir call|कल बात|बाद में|फिर कॉल)/, "follow_up"],
    [/(book|appointment|schedule|interested|qualified|demo|meeting)/, "qualified"],
    [/(resolved|done|thank|perfect|completed)/, "resolved"],
  ] as const;
  const inferred = candidates.find(([pattern]) => pattern.test(normalized))?.[1] ?? "";
  if (!inferred) return null;
  return options.length && !options.includes(inferred) ? null : inferred;
}

export function normalizedCampaignOutcome(input: {
  structuredOutput: unknown;
  tags: string[];
  transcript?: string;
  callbackRequested?: boolean;
  voicemailDetected: boolean;
  status: string;
  endReason: string;
}) {
  if (
    input.tags.some((tag) => /opt.?out|do.?not.?call|unsubscribe/i.test(tag)) ||
    /opt.?out|do.?not.?call|unsubscribe/i.test(input.endReason)
  ) {
    return "not_interested" as const;
  }
  if (input.callbackRequested) return "follow_up" as const;
  if (input.voicemailDetected || input.tags.includes("voicemail")) return "missed" as const;
  const structured =
    input.structuredOutput && typeof input.structuredOutput === "object" && !Array.isArray(input.structuredOutput)
      ? input.structuredOutput as Record<string, unknown>
      : {};
  const raw = String(structured.outcome ?? structured.disposition ?? structured.result ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
  if (["qualified", "booked", "appointment_booked", "interested", "meeting_booked"].includes(raw)) {
    return "qualified" as const;
  }
  if (["follow_up", "callback", "needs_callback", "call_back"].includes(raw)) {
    return "follow_up" as const;
  }
  if (["resolved", "completed", "success", "successful"].includes(raw)) return "resolved" as const;
  if (["missed", "voicemail", "no_answer", "unanswered"].includes(raw)) return "missed" as const;
  if (["not_interested", "declined", "rejected", "do_not_call", "opted_out"].includes(raw)) {
    return "not_interested" as const;
  }
  if (input.status === "failed" && /not.?answered|no.?answer|voicemail/i.test(input.endReason)) {
    return "missed" as const;
  }
  const inferred = inferOutcome(input.transcript ?? "");
  if (inferred) return inferred;
  return "unknown" as const;
}

export function campaignOutcomeCitation(
  transcript: Array<{ itemId?: string; role?: string; text?: string }>,
  outcome: ReturnType<typeof normalizedCampaignOutcome>,
) {
  if (outcome === "unknown" || outcome === "missed") return { quote: "", itemId: "" };
  const userItems = transcript.filter((item) => item.role === "user" && String(item.text ?? "").trim());
  const match = [...userItems].reverse().find((item) => inferOutcome(String(item.text ?? "")) === outcome);
  if (!match) return { quote: "", itemId: "" };
  return {
    quote: String(match.text ?? "").trim().slice(0, 1000),
    itemId: String(match.itemId ?? "").trim().slice(0, 200),
  };
}

export async function backfillCampaignOutcomes(
  campaignId: unknown,
  ownerId: string,
  limit = 500,
) {
  const leads = await CampaignLeadModel.find({
    campaignId,
    ownerId,
    outcomeEvidence: { $nin: ["system_confirmed", "human_reviewed"] },
    $or: [{ outcome: "unknown" }, { outcome: { $exists: false } }],
  })
    .sort({ row: 1 })
    .limit(Math.max(1, Math.min(1000, limit)))
    .select("_id")
    .lean();
  if (!leads.length) return 0;

  const calls = await CallDetailRecordModel.find({
    campaignId,
    ownerId,
    campaignLeadId: { $in: leads.map((lead) => lead._id) },
    status: { $in: ["completed", "failed", "cancelled"] },
  })
    .sort({ createdAt: -1 })
    .select(
      "_id campaignLeadId status endReason tags voicemailDetected structuredOutput callbackRequested transcript",
    )
    .lean();
  const latestByLead = new Map<string, (typeof calls)[number]>();
  for (const call of calls) {
    const key = String(call.campaignLeadId ?? "");
    if (key && !latestByLead.has(key)) latestByLead.set(key, call);
  }

  const operations = leads.flatMap((lead) => {
    const call = latestByLead.get(String(lead._id));
    if (!call) return [];
    const outcome = normalizedCampaignOutcome({
      structuredOutput: call.structuredOutput,
      tags: call.tags ?? [],
      transcript: (call.transcript ?? [])
        .filter((item) => item.role === "user")
        .map((item) => item.text)
        .join("\n"),
      callbackRequested: call.callbackRequested,
      voicemailDetected: call.voicemailDetected,
      status: call.status,
      endReason: call.endReason,
    });
    if (outcome === "unknown") return [];
    const citation = campaignOutcomeCitation(call.transcript ?? [], outcome);
    return [{
      updateOne: {
        filter: {
          _id: lead._id,
          ownerId,
          outcomeEvidence: { $nin: ["system_confirmed", "human_reviewed"] },
          $or: [{ outcome: "unknown" }, { outcome: { $exists: false } }],
        },
        update: {
          $set: {
            outcome,
            outcomeEvidence: "inferred" as const,
            outcomeCallId: call._id,
            outcomeUpdatedAt: new Date(),
            outcomeEvidenceQuote: citation.quote,
            outcomeEvidenceItemId: citation.itemId,
          },
        },
      },
    }];
  });
  if (!operations.length) return 0;
  const result = await CampaignLeadModel.bulkWrite(operations, { ordered: false });
  return result.modifiedCount;
}

function inferPriority(text: string, options: string[] = []) {
  const normalized = text.toLowerCase();
  const value =
    /(urgent|emergency|immediately|as soon as possible|asap)/.test(normalized)
      ? "urgent"
      : /(problem|complaint|angry|cancel|failed)/.test(normalized)
        ? "high"
        : /(later|whenever|low priority)/.test(normalized)
          ? "low"
          : "medium";
  return options.length && !options.includes(value) ? options[0] : value;
}

function localStructuredOutput(
  transcript: string,
  fields: ExtractionField[],
  call: { callerNumber?: string; calledNumber?: string; status?: string; durationSeconds?: number },
) {
  const text = transcript.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const output: Record<string, unknown> = {};
  const email = firstMatch(text, [/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i]);
  const phone = call.callerNumber || firstMatch(text, [/(\+?\d[\d\s().-]{7,}\d)/]);
  const date = firstMatch(text, [
    /\b(today|tomorrow|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
    /\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/,
  ]);

  for (const field of fields) {
    const key = field.key.toLowerCase();
    if (key.includes("outcome")) {
      output[field.key] = inferOutcome(lower, field.options);
    } else if (key.includes("priority") || key.includes("urgency")) {
      output[field.key] = inferPriority(lower, field.options);
    } else if (key.includes("caller") && key.includes("name")) {
      output[field.key] = firstMatch(text, [
        /\bmy name is ([A-Za-z][A-Za-z\s.'-]{1,80})/i,
        /\bthis is ([A-Za-z][A-Za-z\s.'-]{1,80})/i,
        /\bi am ([A-Za-z][A-Za-z\s.'-]{1,80})/i,
      ]);
    } else if (key.includes("intent") || key.includes("reason")) {
      output[field.key] =
        lower.includes("appointment") || lower.includes("book")
          ? "appointment"
          : lower.includes("price") || lower.includes("cost")
            ? "pricing"
            : lower.includes("support") || lower.includes("problem")
              ? "support"
              : lower.includes("cancel")
                ? "cancellation"
                : "";
    } else if (key.includes("next")) {
      output[field.key] =
        lower.includes("call back") || lower.includes("follow up")
          ? "follow_up"
          : lower.includes("book") || lower.includes("appointment")
            ? "schedule_appointment"
            : lower.includes("email")
              ? "send_email"
              : "";
    } else if (key.includes("email")) {
      output[field.key] = email;
    } else if (key.includes("phone")) {
      output[field.key] = phone;
    } else if (field.type === "date" || key.includes("date") || key.includes("time")) {
      output[field.key] = date;
    } else if (field.type === "number") {
      const value = firstMatch(text, [/\b(\d+(?:\.\d+)?)\b/]);
      output[field.key] = value ? Number(value) : null;
    } else if (field.type === "boolean") {
      output[field.key] = /\b(yes|confirmed|agree|interested|resolved)\b/i.test(text);
    } else if (field.type === "enum" && field.options?.length) {
      output[field.key] =
        field.options.find((option) => lower.includes(option.toLowerCase().replaceAll("_", " "))) ?? field.options[0];
    } else {
      output[field.key] = "";
    }
  }

  return output;
}

async function aiStructuredOutput(transcript: string, fields: ExtractionField[]) {
  if (!env.enablePostCallAiAnalysis || !env.openaiApiKey || fields.length === 0) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Return JSON only. Extract exactly the configured keys from the call transcript. Use null when a value is not present.",
          },
          {
            role: "user",
            content: JSON.stringify({
              fields: fields.map((field) => ({
                key: field.key,
                type: field.type,
                description: field.description,
                options: field.options ?? [],
                required: Boolean(field.required),
              })),
              transcript: transcript.slice(0, 30000),
            }),
          },
        ],
      }),
    });
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    if (!response.ok) return null;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function usageRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function positiveUsageNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function hasRealtimeAudioUsage(modelUsage: Record<string, unknown>[], llmProvider: string, llmModel: string) {
  const configuredModel = `${llmProvider}:${llmModel}`.toLowerCase();
  return (
    configuredModel.includes("realtime") ||
    configuredModel.includes("live") ||
    modelUsage.some((item) =>
      item.type === "llm_usage" &&
      (positiveUsageNumber(item.inputAudioTokens) > 0 || positiveUsageNumber(item.outputAudioTokens) > 0),
    )
  );
}

function reportedSttAudioSeconds(modelUsage: Record<string, unknown>[]) {
  return modelUsage
    .filter((item) => item.type === "stt_usage")
    .reduce((sum, item) => sum + positiveUsageNumber(item.audioDurationMs) / 1000, 0);
}

export function fallbackDurationSeconds(call: { durationSeconds?: number; startedAt?: Date | null; endedAt?: Date | null }) {
  if (call.durationSeconds && call.durationSeconds > 0) return call.durationSeconds;
  // createdAt is when dialing/setup began, not when the customer answered.
  // Falling back to it turns an unanswered SIP timeout into fake talk time.
  if (!call.startedAt) return 0;
  const end = call.endedAt ?? new Date();
  return Math.max(0, Math.round((end.getTime() - call.startedAt.getTime()) / 1000));
}

export async function finalizeCallIntelligence(
  roomName: string,
  options: { terminalDataRevision?: number; terminalFinalizationToken?: string } = {},
) {
  const ownershipFilter = typeof options.terminalDataRevision === "number"
    ? {
        terminalDataRevision: options.terminalDataRevision,
        terminalFinalizationStatus: "processing",
        terminalFinalizationToken: options.terminalFinalizationToken ?? "",
      }
    : {};
  const call = await CallDetailRecordModel.findOne({
    livekitRoomName: roomName,
    ...ownershipFilter,
  });
  if (!call) return null;
  const modelUsage = usageRecords(call.modelUsage);
  const billableDurationSeconds = fallbackDurationSeconds(call);
  if (call.durationSeconds <= 0 && billableDurationSeconds > 0) {
    call.durationSeconds = billableDurationSeconds;
  }
  const sttSecondsFromUsage = reportedSttAudioSeconds(modelUsage);
  const shouldEstimateSttSeconds =
    call.sttSeconds <= 0 &&
    sttSecondsFromUsage <= 0 &&
    billableDurationSeconds > 0 &&
    Boolean(call.sttProvider && call.sttModel) &&
    !hasRealtimeAudioUsage(modelUsage, call.llmProvider, call.llmModel);
  const billableSttSeconds = shouldEstimateSttSeconds ? billableDurationSeconds : call.sttSeconds;
  if (shouldEstimateSttSeconds) {
    call.sttSeconds = billableSttSeconds;
    modelUsage.push({
      type: "stt_usage",
      provider: call.sttProvider,
      model: call.sttModel,
      audioDurationMs: Math.round(billableSttSeconds * 1000),
      estimated: true,
      note: "Estimated from call duration because provider did not report STT audio usage.",
    });
    call.modelUsage = modelUsage;
  }
  // For realtime calls, the SDK may overwrite llmModel with the underlying model name
  // (e.g. "gpt-4.1") during recordCallUsage. Use realtimeModel/realtimeProvider and the
  // isRealtime flag so calculateCallCost re-prices every usage item at the configured
  // realtime model. Pipeline calls also store realtimeModel as configuration history,
  // so that field alone must never switch billing/display into realtime mode.
  const isRealtimeCall =
    call.pipelineMode === "realtime" ||
    hasRealtimeAudioUsage(modelUsage, call.llmProvider, call.llmModel);
  const billingLlmProvider = isRealtimeCall ? (call.realtimeProvider || call.llmProvider) : call.llmProvider;
  const billingLlmModel = isRealtimeCall
    ? normalizeRealtimeModel(billingLlmProvider, call.realtimeModel || call.llmModel)
    : call.llmModel;

  call.costBreakdown = calculateCallCost({
    llmProvider: billingLlmProvider,
    llmModel: billingLlmModel,
    llmInputTokens: call.llmInputTokens,
    llmOutputTokens: call.llmOutputTokens,
    llmTokens: call.llmTokens,
    sttProvider: call.sttProvider,
    sttModel: call.sttModel,
    sttLanguage: call.language,
    sttSeconds: billableSttSeconds,
    sttInputTokens: call.sttInputTokens,
    sttOutputTokens: call.sttOutputTokens,
    ttsProvider: call.ttsProvider,
    ttsModel: call.ttsModel,
    ttsVoice: call.ttsVoice,
    ttsCharacters: call.ttsCharacters,
    ttsAudioSeconds: call.ttsAudioSeconds,
    ttsInputTokens: call.ttsInputTokens,
    ttsOutputTokens: call.ttsOutputTokens,
    durationSeconds: billableDurationSeconds,
    modelUsage,
    isRealtime: isRealtimeCall,
  });

  const transcript = call.transcript.map((item) => `${item.role}: ${item.text}`).join("\n");
  const callerTranscript = call.transcript
    .filter((item) => item.role === "user")
    .map((item) => item.text)
    .join("\n");
  if (call.transcript.length) {
    const analysis = (await aiAnalysis(transcript)) ?? localAnalysis(transcript);
    call.sentimentScore = analysis.score;
    call.sentimentLabel = analysis.label;
    call.tags = [...new Set([...call.tags, ...analysis.tags])];

    const agent = await VoiceAgentModel.findById(call.agentId).select("analysisPlan");
    const fields = (agent?.analysisPlan?.fields ?? []) as ExtractionField[];
    if (agent?.analysisPlan?.enabled && fields.length) {
      call.structuredOutputStatus = "pending";
      try {
        const existingStructuredOutput =
          call.structuredOutput && typeof call.structuredOutput === "object" && !Array.isArray(call.structuredOutput)
            ? (call.structuredOutput as Record<string, unknown>)
            : {};
        const extractedStructuredOutput =
          (await aiStructuredOutput(transcript, fields)) ??
          localStructuredOutput(transcript, fields, {
            callerNumber: call.callerNumber,
            calledNumber: call.calledNumber,
            status: call.status,
            durationSeconds: call.durationSeconds,
          });
        call.structuredOutput = { ...extractedStructuredOutput, ...existingStructuredOutput };
        call.structuredOutputStatus = "completed";
        call.structuredOutputError = "";
      } catch (error) {
        call.structuredOutputStatus = "failed";
        call.structuredOutputError = error instanceof Error ? error.message : String(error);
      }
    } else {
      call.structuredOutputStatus = "skipped";
    }
  } else {
    call.structuredOutputStatus = "skipped";
  }
  const intelligence: Record<string, unknown> = {
    durationSeconds: call.durationSeconds,
    sttSeconds: call.sttSeconds,
    modelUsage: call.modelUsage,
    costBreakdown: call.costBreakdown,
    tags: call.tags,
    structuredOutput: call.structuredOutput,
    structuredOutputStatus: call.structuredOutputStatus,
    structuredOutputError: call.structuredOutputError,
  };
  if (typeof call.sentimentScore === "number") intelligence.sentimentScore = call.sentimentScore;
  if (call.sentimentLabel) intelligence.sentimentLabel = call.sentimentLabel;

  const persisted = await CallDetailRecordModel.updateOne(
    { _id: call._id, ...ownershipFilter },
    { $set: intelligence },
    { runValidators: true },
  );
  if (persisted.matchedCount !== 1) return null;
  if (call.campaignLeadId) {
    const outcome = normalizedCampaignOutcome({
      structuredOutput: call.structuredOutput,
      tags: call.tags,
      transcript: callerTranscript,
      callbackRequested: call.callbackRequested,
      voicemailDetected: call.voicemailDetected,
      status: call.status,
      endReason: call.endReason,
    });
    const citation = campaignOutcomeCitation(call.transcript, outcome);
    await CampaignLeadModel.updateOne(
      {
        _id: call.campaignLeadId,
        ownerId: call.ownerId,
        outcomeEvidence: { $nin: ["system_confirmed", "human_reviewed"] },
        ...(outcome === "unknown"
          ? { $or: [{ outcome: "unknown" }, { outcome: { $exists: false } }] }
          : {}),
      },
      {
        $set: {
          outcome,
          outcomeEvidence: outcome === "unknown" ? "unknown" : "inferred",
          outcomeCallId: call._id,
          outcomeUpdatedAt: new Date(),
          outcomeEvidenceQuote: citation.quote,
          outcomeEvidenceItemId: citation.itemId,
        },
      },
    );
  }
  return CallDetailRecordModel.findById(call._id);
}
