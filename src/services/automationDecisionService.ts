export type AutomationDecision = "interested" | "callback" | "not_interested" | "unknown";

export function classifyWhatsAppReply(reply: string): AutomationDecision {
  const text = reply.toLowerCase().trim();
  if (!text) return "unknown";
  if (/\b(?:stop|unsubscribe|cancel|no|not interested|do not contact|don't contact)\b/.test(text)) return "not_interested";
  if (/\b(?:later|reschedule|callback|call back|tomorrow|busy|not now)\b/.test(text)) return "callback";
  if (/\b(?:yes|interested|book|confirm|sure|ok|price|pricing|demo|buy)\b/.test(text)) return "interested";
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
