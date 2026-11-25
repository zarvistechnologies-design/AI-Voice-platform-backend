import assert from "node:assert/strict";
import test from "node:test";
import { buildAgenticDecisionPrompt, classifyWhatsAppReply, routeAutomationOutcome } from "../src/services/automationDecisionService.js";

test("negative replies cannot take an interested branch", () => {
  assert.equal(classifyWhatsAppReply("Not interested, please stop"), "not_interested");
  assert.equal(classifyWhatsAppReply("I know the price"), "interested");
  assert.equal(classifyWhatsAppReply("unknown details"), "unknown");
});

test("a later customer reply overrides an earlier call outcome", () => {
  assert.equal(routeAutomationOutcome("qualified", "No, do not contact me"), "not_interested");
  assert.equal(routeAutomationOutcome("qualified", "Tomorrow, please"), "callback");
  assert.equal(routeAutomationOutcome("qualified", ""), "interested");
});

test("agentic workflow prompt includes recent WhatsApp conversation context", () => {
  const prompt = JSON.parse(buildAgenticDecisionPrompt({
    routingGoal: "Classify solar buying interest from the conversation.",
    mode: "agentic",
    callOutcome: "unknown",
    whatsappReply: "Tata",
    whatsappConversation: "Assistant: Which solar panel brand do you prefer?\nCustomer: Tata",
  }));

  assert.equal(prompt.whatsappReply, "Tata");
  assert.match(prompt.whatsappConversation, /Assistant: Which solar panel brand do you prefer\?/);
  assert.match(prompt.whatsappConversation, /Customer: Tata/);
});
