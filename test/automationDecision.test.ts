import assert from "node:assert/strict";
import test from "node:test";
import { buildAgenticDecisionPrompt, classifyWhatsAppReply, customerAcceptedWhatsAppDetailsOffer, customerExplicitlyRequestedWhatsAppDetails, evaluateAgenticDecision, routeAutomationOutcome } from "../src/services/automationDecisionService.js";

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

test("explicit caller request for WhatsApp details selects the follow-up branch", async () => {
  const transcript = "Customer: WhatsApp WhatsApp पर डिटेल भेज दीजिए।\nAssistant: मैं जानकारी भेज दूँगा।";
  assert.equal(customerExplicitlyRequestedWhatsAppDetails(transcript), true);
  const result = await evaluateAgenticDecision({
    decisionType: "agentic",
    callOutcome: "unknown",
    callSummary: transcript,
    requiredAction: "whatsapp_details",
  });
  assert.equal(result.decision, "interested");
  assert.equal(result.usedLlm, false);
});

test("WhatsApp details request is not inferred from assistant speech or a customer decline", () => {
  assert.equal(customerExplicitlyRequestedWhatsAppDetails("Assistant: I can send solar details on WhatsApp."), false);
  assert.equal(customerExplicitlyRequestedWhatsAppDetails("Customer: Don't send details on WhatsApp."), false);
});

test("caller accepts the agent's WhatsApp details offer without repeating WhatsApp", () => {
  const offer = "क्या आप सोलर की जानकारी WhatsApp पर प्राप्त करना चाहेंगे?";
  assert.equal(customerAcceptedWhatsAppDetailsOffer(offer, "भेज दीजिए।"), true);
  assert.equal(customerAcceptedWhatsAppDetailsOffer(offer, "नहीं भेजना"), false);
  assert.equal(customerAcceptedWhatsAppDetailsOffer("क्या आप सोलर लगवाना चाहेंगे?", "भेज दीजिए"), false);
});
