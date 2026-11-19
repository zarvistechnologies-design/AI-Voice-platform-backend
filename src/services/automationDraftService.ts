import type { AutomationGraph, AutomationNode } from "./automationDefinitionService.js";

type Draft = { name: string; description: string; graph: AutomationGraph };

// A deterministic fallback when AI drafting is unavailable. It includes only actions
// mentioned in the request and leaves account-specific approvals for publish checks.
export function buildAutomationDraftFromPrompt(
  prompt: string,
  defaults: { agentId: string; phoneNumberId: string; templateName: string },
): Draft {
  const lower = prompt.toLowerCase();
  const triggerEvent = /missed\s+(?:inbound\s+)?call/.test(lower) ? "missed_call"
    : /(?:inbound|receive|received|customer messages|lead messages).*whatsapp|whatsapp.*(?:inbound|received|messages us)/.test(lower) ? "whatsapp_inbound"
    : /(?:import|campaign).*lead|lead.*(?:import|campaign)/.test(lower) ? "contact_added"
    : "manual";
  const nodes: AutomationNode[] = [{
    id: "trigger_1", type: "trigger", title: "Start", x: 60, y: 180,
    config: { event: triggerEvent, ...(triggerEvent === "contact_added" ? { campaignId: "all" } : {}),
      ...(triggerEvent === "missed_call" ? { phoneNumberId: "", consentConfirmed: "false" } : {}),
      ...(triggerEvent === "whatsapp_inbound" ? { consentConfirmed: "false" } : {}) },
  }];
  const candidates: Array<{ index: number; type: AutomationNode["type"]; title: string; config: Record<string, string> }> = [];
  const add = (pattern: RegExp, type: AutomationNode["type"], title: string, config: Record<string, string>) => {
    const match = pattern.exec(lower);
    if (match) candidates.push({ index: match.index, type, title, config });
  };
  add(/send\s+(?:a\s+)?whatsapp|whatsapp\s+(?:outreach|follow.?up|template)|message\s+(?:the\s+)?lead/, "whatsapp", "Send WhatsApp", {
    messageMode: "template", templateName: defaults.templateName, language: "en", bodyVariables: "",
  });
  add(/(?:place|make|start|schedule|return)\s+(?:an?\s+)?(?:ai\s+|voice\s+)?(?:call|callback)|\bcall\s+(?:the\s+)?(?:lead|customer|contact)|\bcall\s+back\b|\bcallback\b/, "call", "Voice call", {
    agentId: defaults.agentId, phoneNumberId: defaults.phoneNumberId,
    windowStart: "09:00", windowEnd: "20:00", timezone: "Asia/Kolkata",
  });
  add(/\bwait\b|\bdelay\b/, "wait", "Wait", { minutes: "30" });
  add(/\bqualif(?:y|ication)\b|\broute\b|\bif interested\b|\bbranch\b/, "decision", "Route by outcome", { decisionType: "agentic" });
  add(/\bcalendar\b|\bappointment\b|\bbooking\b/, "calendar", "Schedule appointment", {
    calendarTitle: "Consultation", durationMinutes: "30", calendarProvider: "auto",
  });
  add(/\bcrm\b|\bsalesforce\b|\bhubspot\b|\bzoho\b|\bsheets?\b/, "crm", "Update contact", {
    crmStage: "Qualified", crmTag: "Workflow", crmProvider: "all",
  });
  add(/\bpayment\b|\brazorpay\b|\bpay link\b/, "payment", "Create payment link", {
    amount: "999", currency: "INR", description: "Payment for {{name}}", sendWhatsApp: "false",
  });
  add(/\bslack\b|\bteam alert\b|\bnotify team\b/, "sms", "Notify team", {
    messageText: "Workflow update for {{name}} ({{phone}})",
  });
  candidates.sort((a, b) => a.index - b.index);
  candidates.forEach((item, index) => nodes.push({
    id: `step_${index + 1}`, type: item.type, title: item.title,
    x: 360 + index * 320, y: 180, config: item.config,
  }));
  const endX = 360 + candidates.length * 320;
  nodes.push({ id: "end_success", type: "end", title: "Complete", x: endX, y: 180, config: {} });
  const edges: AutomationGraph["edges"] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index];
    const target = nodes[index + 1];
    edges.push({ id: `next_${index}`, source: source.id, target: target.id, sourceHandle: source.type === "decision" ? "interested" : "default" });
  }
  for (const node of [...nodes]) {
    const branches = node.type === "call" ? [["failed", "Call failed"]]
      : node.type === "decision" ? [["callback", "Callback"], ["not_interested", "Not interested"], ["unknown", "Review"]]
      : [];
    branches.forEach(([handle, title], index) => {
      const endId = `${node.id}_${handle}`;
      nodes.push({ id: endId, type: "end", title, x: node.x + 320, y: 380 + index * 160, config: {} });
      edges.push({ id: `${node.id}_${handle}_edge`, source: node.id, target: endId, sourceHandle: handle as AutomationGraph["edges"][number]["sourceHandle"] });
    });
  }
  return {
    name: prompt.slice(0, 60).trim() || "Workflow",
    description: `Drafted from: ${prompt.slice(0, 180)}`,
    graph: { schemaVersion: 1, nodes, edges },
  };
}
