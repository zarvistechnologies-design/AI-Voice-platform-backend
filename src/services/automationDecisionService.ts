import { env } from "../config/env.js";

export type AutomationDecision = "interested" | "callback" | "not_interested" | "unknown";

export function classifyWhatsAppReply(reply: string): AutomationDecision {
  const text = reply.toLowerCase().trim();
  if (!text) return "unknown";
  if (/\b(?:stop|unsubscribe|cancel|no|not interested|do not contact|don't contact)\b/.test(text)) return "not_interested";
  if (/\b(?:later|reschedule|callback|call back|tomorrow|busy|not now)\b/.test(text)) return "callback";
  if (/\b(?:yes|interested|book|confirm|sure|ok|price|pricing|demo|buy|paid|pay)\b/.test(text)) return "interested";
  return "unknown";
}

export function routeAutomationOutcome(callOutcome: string, reply: string): AutomationDecision {
  const replyDecision = classifyWhatsAppReply(reply);
  if (replyDecision !== "unknown") return replyDecision;
  if (callOutcome === "qualified") return "interested";
  if (callOutcome === "follow_up") return "callback";
  if (callOutcome === "not_interested") return "not_interested";
  return "unknown";
}

export function buildAgenticDecisionPrompt(input: {
  routingGoal: string;
  mode: string;
  callOutcome: string;
  callSummary?: string;
  whatsappReply?: string;
  whatsappConversation?: string;
  paymentPaid?: boolean;
  crmStage?: string;
  tags?: string[];
}) {
  return JSON.stringify({
    routingGoal: input.routingGoal,
    mode: input.mode,
    callOutcome: input.callOutcome,
    callSummary: (input.callSummary || "").slice(0, 400),
    whatsappReply: (input.whatsappReply || "").slice(0, 400),
    whatsappConversation: (input.whatsappConversation || "").slice(-6000),
    paymentPaid: Boolean(input.paymentPaid),
    crmStage: input.crmStage || "",
    tags: input.tags || [],
  });
}

export function customerExplicitlyRequestedWhatsAppDetails(callSummary: string) {
  const customerText = callSummary
    .split(/\r?\n/)
    .filter((line) => /^Customer:\s*/i.test(line))
    .map((line) => line.replace(/^Customer:\s*/i, ""))
    .join(" ")
    .trim();
  if (!customerText) return false;

  const declined = /\b(?:don't|dont|do not|never|stop|no)\b[^.!?]{0,60}\b(?:send|share|forward|whatsapp)\b/i.test(customerText)
    || /(?:मत|नहीं)[^।.!?]{0,40}(?:भेज|WhatsApp)/i.test(customerText);
  if (declined) return false;

  const mentionsWhatsApp = /whats\s*app|व्हाट्स\s*ऐप|व्हाट्सएप/i.test(customerText);
  const requestsSending = /\b(?:send|share|forward|bhej|bhejiye|bhej\s*dijiye)\b|भेज/i.test(customerText);
  const mentionsDetails = /\b(?:detail|details|info|information)\b|जानकारी|डिटेल|विवरण/i.test(customerText);
  return mentionsWhatsApp && (requestsSending || mentionsDetails);
}

async function callWorkflowLlm(systemPrompt: string, userPrompt: string, maxTokens = 180): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    if (env.openaiApiKey) {
      const res = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    }

    if (env.googleApiKey) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.googleApiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
        if (text) return text;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export async function evaluateAgenticDecision(input: {
  decisionType: string;
  agentGoal?: string;
  callOutcome: string;
  callSummary?: string;
  whatsappReply?: string;
  whatsappConversation?: string;
  requiredAction?: string;
  paymentPaid?: boolean;
  crmStage?: string;
  tags?: string[];
}): Promise<{ decision: AutomationDecision; reason: string; usedLlm: boolean }> {
  if (input.requiredAction === "whatsapp_details" && customerExplicitlyRequestedWhatsAppDetails(input.callSummary || "")) {
    return {
      decision: "interested",
      reason: "Customer explicitly requested solar details on WhatsApp during the call.",
      usedLlm: false,
    };
  }

  const fallback =
    input.decisionType === "whatsapp"
      ? classifyWhatsAppReply(input.whatsappReply || "")
      : input.decisionType === "call"
        ? (input.callOutcome === "qualified"
            ? "interested"
            : input.callOutcome === "follow_up"
              ? "callback"
              : input.callOutcome === "not_interested"
                ? "not_interested"
                : "unknown")
        : routeAutomationOutcome(input.callOutcome, input.whatsappReply || "");

  const hasSignal = Boolean(
    input.whatsappReply?.trim() ||
    input.callSummary?.trim() ||
    (input.callOutcome && input.callOutcome !== "unknown") ||
    input.paymentPaid,
  );
  const shouldUseLlm =
    hasSignal &&
    (input.decisionType === "agentic" || Boolean(input.agentGoal?.trim())) &&
    Boolean(env.openaiApiKey || env.googleApiKey);

  if (!shouldUseLlm) {
    return {
      decision: input.paymentPaid && fallback === "unknown" ? "interested" : fallback,
      reason: `rule-based (call=${input.callOutcome}${input.whatsappReply ? `, chat="${input.whatsappReply.slice(0, 40)}"` : ""})`,
      usedLlm: false,
    };
  }

  const systemPrompt = [
    "You are an enterprise workflow routing classifier.",
    "Classify the customer's state into EXACTLY one of four routes: interested, callback, not_interested, unknown.",
    "Use whatsappConversation to understand short replies in context. Turns are labeled Customer or Assistant; only Customer messages express customer intent. Interpret a brief answer using the immediately preceding Assistant question.",
    'Return ONLY valid JSON: {"route":"interested|callback|not_interested|unknown","reason":"short 6-12 word explanation"}',
    "Do not include markdown fences or extra text.",
  ].join(" ");

  const userPrompt = buildAgenticDecisionPrompt({
    routingGoal: input.agentGoal?.trim() || "Route interested/buying/booking leads to interested, busy/later leads to callback, opt-out/declines to not_interested, unclear to unknown.",
    mode: input.decisionType,
    callOutcome: input.callOutcome,
    callSummary: input.callSummary,
    whatsappReply: input.whatsappReply,
    whatsappConversation: input.whatsappConversation,
    paymentPaid: input.paymentPaid,
    crmStage: input.crmStage,
    tags: input.tags,
  });

  const raw = await callWorkflowLlm(systemPrompt, userPrompt, 120);
  if (raw) {
    try {
      const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      const parsed = JSON.parse(cleaned) as { route?: string; reason?: string };
      const valid: AutomationDecision[] = ["interested", "callback", "not_interested", "unknown"];
      if (parsed.route && valid.includes(parsed.route as AutomationDecision)) {
        return {
          decision: parsed.route as AutomationDecision,
          reason: String(parsed.reason || "AI evaluated context").slice(0, 120),
          usedLlm: true,
        };
      }
    } catch {
      const match = raw.toLowerCase().match(/\b(not_interested|interested|callback|unknown)\b/);
      if (match) {
        return {
          decision: match[1] as AutomationDecision,
          reason: "AI evaluated context",
          usedLlm: true,
        };
      }
    }
  }

  return {
    decision: input.paymentPaid && fallback === "unknown" ? "interested" : fallback,
    reason: `fallback (call=${input.callOutcome})`,
    usedLlm: false,
  };
}

export async function generateDynamicWhatsAppMessage(input: {
  promptHint: string;
  contactName: string;
  outcome?: string;
  callSummary?: string;
  whatsappReply?: string;
  paymentLink?: string;
  calendlyLink?: string;
  calendarTime?: string;
  crmStage?: string;
  fallbackText: string;
}): Promise<{ text: string; usedLlm: boolean }> {
  if (!env.openaiApiKey && !env.googleApiKey) {
    return { text: input.fallbackText, usedLlm: false };
  }

  const systemPrompt = [
    "You write concise, warm, professional WhatsApp business messages.",
    "Keep messages under 600 characters, plain WhatsApp formatting only (no markdown headings or code blocks).",
    "Include any provided paymentLink or calendlyLink verbatim if relevant to the instruction.",
    "Return ONLY the final message text ready to send to the customer.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    instruction: input.promptHint || "Follow up warmly with the customer and confirm next steps.",
    customerName: input.contactName || "there",
    callOutcome: input.outcome || "",
    callSummary: (input.callSummary || "").slice(0, 400),
    lastCustomerWhatsAppMessage: (input.whatsappReply || "").slice(0, 300),
    paymentLink: input.paymentLink || "",
    bookingLink: input.calendlyLink || "",
    scheduledTime: input.calendarTime || "",
    crmStage: input.crmStage || "",
  });

  const generated = await callWorkflowLlm(systemPrompt, userPrompt, 240);
  if (generated && generated.length >= 8) {
    return { text: generated.slice(0, 1000), usedLlm: true };
  }
  return { text: input.fallbackText, usedLlm: false };
}
