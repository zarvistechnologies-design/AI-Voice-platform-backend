import type { AutomationGraph } from "./automationDefinitionService.js";

export function simulateAutomation(graph: AutomationGraph, sampleOutcome: string) {
  const steps: Array<{ nodeId: string; title: string; type: string; detail: string }> = [];
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  let id = trigger?.id ?? "";
  for (let count = 0; id && count < 100; count += 1) {
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) break;
    let handle = "default";
    let detail = "Would execute";
    if (node.type === "trigger") detail = `${(node.config.event || "manual").replaceAll("_", " ")} event received`;
    if (node.type === "call") {
      handle = sampleOutcome === "missed" ? "failed" : "default";
      detail = handle === "failed" ? "Sample call fails or is missed; follow the failure branch" : "Would place a call using the selected agent";
    }
    if (node.type === "whatsapp") {
      detail = node.config.messageMode === "ai_dynamic"
        ? `Would send AI-generated WhatsApp message (${node.config.aiPrompt ? node.config.aiPrompt.slice(0, 45) : "contextual"})`
        : `Would send WhatsApp template ${node.config.templateName || "(not configured)"}`;
    }
    if (node.type === "wait") detail = `Would wait ${node.config.minutes || "?"} minutes`;
    if (node.type === "crm") detail = `Would sync lead to connected CRMs/Sheets (stage: ${node.config.crmStage || "Qualified"}, tag: ${node.config.crmTag || "CRM-Synced"})`;
    if (node.type === "calendar") detail = `Would book Google Calendar / Calendly appointment: ${node.config.calendarTitle || "AI Consultation"} (${node.config.durationMinutes || "30"} min)`;
    if (node.type === "payment") detail = `Would create Razorpay Payment Link for ${node.config.currency || "INR"} ${node.config.amount || "999"} and send via WhatsApp`;
    if (node.type === "sms") detail = `Would dispatch Slack & instant notification: "${(node.config.messageText || "Follow-up alert").slice(0, 45)}"`;
    if (node.type === "decision") {
      handle = sampleOutcome === "qualified" ? "interested" : sampleOutcome === "follow_up" ? "callback" : sampleOutcome === "not_interested" ? "not_interested" : "unknown";
      detail = `AI Agentic Router (${node.config.decisionType || "agentic"}): ${sampleOutcome} → ${handle}`;
    }
    if (node.type === "condition") {
      handle = sampleOutcome === node.config.value ? "yes" : "no";
      detail = `${sampleOutcome} ${handle === "yes" ? "matches" : "does not match"} ${node.config.value || "(unset)"}`;
    }
    if (node.type === "end") detail = `Would finish: ${node.config.outcome || node.title}`;
    steps.push({ nodeId: node.id, title: node.title, type: node.type, detail });
    if (node.type === "end") break;
    id = graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === handle)?.target
      ?? graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === "default")?.target ?? "";
  }
  return steps;
}
