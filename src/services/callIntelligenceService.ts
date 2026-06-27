import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { deductCreditsForCall } from "./billingService.js";
import { calculateCallCost } from "./modelPricingService.js";

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
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

function inferOutcome(text: string, options: string[] = []) {
  const normalized = text.toLowerCase();
  const candidates = [
    [/(book|appointment|schedule|interested|qualified|demo|meeting)/, "qualified"],
    [/(call back|follow up|later|tomorrow|next week)/, "follow_up"],
    [/(resolved|done|thank|perfect|completed)/, "resolved"],
    [/(voicemail|missed|no answer|not available)/, "missed"],
    [/(not interested|do not call|stop calling|unsubscribe)/, "not_interested"],
  ] as const;
  const inferred = candidates.find(([pattern]) => pattern.test(normalized))?.[1] ?? "follow_up";
  return options.length && !options.includes(inferred) ? options[0] : inferred;
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

function fallbackDurationSeconds(call: { durationSeconds?: number; startedAt?: Date | null; endedAt?: Date | null; createdAt?: Date }) {
  if (call.durationSeconds && call.durationSeconds > 0) return call.durationSeconds;
  const end = call.endedAt ?? new Date();
  const start = call.startedAt ?? call.createdAt;
  if (!start) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

export async function finalizeCallIntelligence(roomName: string) {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
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
  call.costBreakdown = calculateCallCost({
    llmProvider: call.llmProvider,
    llmModel: call.llmModel,
    llmInputTokens: call.llmInputTokens,
    llmOutputTokens: call.llmOutputTokens,
    llmTokens: call.llmTokens,
    sttProvider: call.sttProvider,
    sttModel: call.sttModel,
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
  });

  if (call.transcript.length) {
    const transcript = call.transcript.map((item) => `${item.role}: ${item.text}`).join("\n");
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
  await call.save();
  if (call.status === "completed" || call.status === "failed") {
    await deductCreditsForCall({
      id: call.id,
      ownerId: call.ownerId,
      durationSeconds: call.durationSeconds,
      llmTokens: call.llmTokens,
      sttSeconds: call.sttSeconds,
      ttsCharacters: call.ttsCharacters,
      costBreakdown: call.costBreakdown,
    });
  }
  return call;
}
