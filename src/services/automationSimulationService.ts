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
    if (node.type === "trigger") detail = node.config.event === "webhook"
      ? "External webhook event received (Zapier / Meta / Site)"
      : node.config.event === "case_created"
        ? `Support case opened${node.config.priority && node.config.priority !== "all" ? ` (priority: ${node.config.priority})` : ""}`
        : node.config.event === "case_resolved"
          ? "Support case marked resolved"
          : `${(node.config.event || "manual").replaceAll("_", " ")} event received`;
    if (node.type === "call") {
      handle = sampleOutcome === "missed" ? "failed" : "default";
      const retries = Number(node.config.maxRetries || 0);
      const retryNote = retries > 0 ? ` (up to ${retries} auto-retr${retries === 1 ? "y" : "ies"} every ${node.config.retryDelayMinutes || "15"}m)` : "";
      detail = handle === "failed"
        ? `Sample call fails or is missed${retryNote}; follow the failure branch`
        : `Would place a call using the selected agent${retryNote}`;
    }
    if (node.type === "whatsapp") {
      detail = node.config.messageMode === "ai_dynamic"
        ? `Would send AI LLM-generated WhatsApp message (${node.config.aiPrompt ? node.config.aiPrompt.slice(0, 45) : "contextual"})`
        : `Would send WhatsApp template ${node.config.templateName || "(not configured)"}`;
    }
    if (node.type === "wait") {
      const waitMode = node.config.waitMode || "duration";
      detail = waitMode === "whatsapp_reply"
        ? `Would wait up to ${node.config.minutes || "60"} min for customer WhatsApp reply (resumes immediately on reply)`
        : waitMode === "payment_paid"
          ? `Would wait up to ${node.config.minutes || "60"} min for Razorpay payment confirmation`
          : waitMode === "case_resolved"
            ? `Would wait up to ${node.config.minutes || "60"} min for Support Case resolution (SLA timer)`
            : `Would wait ${node.config.minutes || "?"} minutes`;
    }
    if (node.type === "case") detail = `Would open Support Case (${node.config.priority || "medium"} / ${node.config.category || "Support"}): "${(node.config.subject || "Customer Support Request").slice(0, 45)}"`;
    if (node.type === "crm") detail = `Would sync lead to connected CRMs/Sheets (stage: ${node.config.crmStage || "Qualified"}, tag: ${node.config.crmTag || "CRM-Synced"})`;
    if (node.type === "calendar") detail = `Would book Google Calendar / Calendly appointment: ${node.config.calendarTitle || "AI Consultation"} (${node.config.durationMinutes || "30"} min)`;
    if (node.type === "payment") detail = `Would create Razorpay Payment Link for ${node.config.currency || "INR"} ${node.config.amount || "999"} and send via WhatsApp`;
    if (node.type === "sms") detail = `Would dispatch Slack & instant notification: "${(node.config.messageText || "Follow-up alert").slice(0, 45)}"`;
    if (node.type === "decision") {
      handle = sampleOutcome === "qualified" ? "interested" : sampleOutcome === "follow_up" ? "callback" : sampleOutcome === "not_interested" ? "not_interested" : "unknown";
      detail = `AI Agentic Router (${node.config.decisionType || "agentic"}): ${sampleOutcome} → ${handle}`;
    }
    if (node.type === "condition") {
      const condType = node.config.conditionType || "outcome";
      const expected = String(node.config.value || "").trim().toLowerCase();
      if (condType === "has_replied") {
        handle = sampleOutcome !== "missed" ? "yes" : "no";
        detail = handle === "yes" ? "Simulated customer reply received → YES" : "Simulated no customer reply → NO";
      } else if (condType === "payment_paid") {
        handle = sampleOutcome === "qualified" ? "yes" : "no";
        detail = handle === "yes" ? "Simulated Razorpay payment completed → YES" : "Simulated payment pending/unpaid → NO";
      } else if (condType === "case_status") {
        const simCase = sampleOutcome === "qualified" ? "resolved" : sampleOutcome === "follow_up" ? "in_progress" : "open";
        handle = simCase === (expected || "resolved") ? "yes" : "no";
        detail = `Support case status (${simCase}) == "${node.config.value || "resolved"}" → ${handle.toUpperCase()}`;
      } else if (condType === "case_priority") {
        const simPriority = sampleOutcome === "missed" ? "urgent" : "medium";
        handle = simPriority === (expected || "urgent") ? "yes" : "no";
        detail = `Support case priority (${simPriority}) == "${node.config.value || "urgent"}" → ${handle.toUpperCase()}`;
      } else if (condType === "whatsapp_status") {
        const simStatus = sampleOutcome === "missed" ? "failed" : "read";
        handle = !expected || simStatus === expected || (expected === "delivered" && simStatus === "read") ? "yes" : "no";
        detail = `WhatsApp status (${simStatus}) vs "${node.config.value || "read"}" → ${handle.toUpperCase()}`;
      } else if (condType === "whatsapp_reply_contains" || condType === "whatsapp_reply_equals") {
        handle = sampleOutcome === "qualified" || sampleOutcome === "follow_up" ? "yes" : "no";
        detail = `WhatsApp reply ${condType === "whatsapp_reply_contains" ? "contains" : "equals"} "${node.config.value || "(unset)"}" → ${handle.toUpperCase()}`;
      } else if (condType === "contact_tag") {
        handle = sampleOutcome === "qualified" ? "yes" : "no";
        detail = `Contact tag "${node.config.value || "(unset)"}" → ${handle.toUpperCase()}`;
      } else {
        handle = sampleOutcome.toLowerCase() === expected ? "yes" : "no";
        detail = `${sampleOutcome} ${handle === "yes" ? "matches" : "does not match"} ${node.config.value || "(unset)"}`;
      }
    }
    if (node.type === "end") detail = `Would finish: ${node.config.outcome || node.title}`;
    steps.push({ nodeId: node.id, title: node.title, type: node.type, detail });
    if (node.type === "end") break;
    id = graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === handle)?.target
      ?? graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === "default")?.target ?? "";
  }
  return steps;
}
