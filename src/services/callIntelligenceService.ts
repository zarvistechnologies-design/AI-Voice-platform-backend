import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { deductCreditsForCall } from "./billingService.js";

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

export async function finalizeCallIntelligence(roomName: string) {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName });
  if (!call) return null;
  const llm = rounded((call.llmTokens / 1_000_000) * env.costRates.llmPerMillionTokens);
  const stt = rounded((call.sttSeconds / 60) * env.costRates.sttPerMinute);
  const tts = rounded((call.ttsCharacters / 1_000_000) * env.costRates.ttsPerMillionCharacters);
  const telephony = rounded((call.durationSeconds / 60) * env.costRates.telephonyPerMinute);
  call.costBreakdown = { llm, stt, tts, telephony, total: rounded(llm + stt + tts + telephony), currency: "USD" };

  if (call.transcript.length) {
    const transcript = call.transcript.map((item) => `${item.role}: ${item.text}`).join("\n");
    const analysis = (await aiAnalysis(transcript)) ?? localAnalysis(transcript);
    call.sentimentScore = analysis.score;
    call.sentimentLabel = analysis.label;
    call.tags = [...new Set([...call.tags, ...analysis.tags])];
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
