import assert from "node:assert/strict";
import test from "node:test";

import { assertGuidedIntegrationReady, buildGuidedAgent, guidedAgentTemplates } from "../src/services/guidedAgentTemplates.js";

function answersFor(template: (typeof guidedAgentTemplates)[number]) {
  return Object.fromEntries(template.questions.map(({ id }) => [id, id === "businessName" ? "Acme Care" : "Example policy"]));
}

test("the seven guided workflows have unique IDs and usable questions", () => {
  assert.equal(guidedAgentTemplates.length, 7);
  assert.equal(new Set(guidedAgentTemplates.map(({ id }) => id)).size, 7);
  for (const template of guidedAgentTemplates) {
    assert.ok(template.questions.some(({ id }) => id === "businessName"));
    assert.ok(template.outcomeFields.length >= 3);
    const result = buildGuidedAgent({ templateId: template.id, answers: answersFor(template), mode: "collect" });
    assert.equal(result.mode, "collect");
    assert.match(result.prompt, /staff must confirm/i);
    assert.match(result.prompt, /Acme Care/);
    assert.ok(result.prompt.length < 2400, `${template.id} prompt should stay focused`);
  }
});

test("connected workflows cannot claim a booking succeeded without a tool result", () => {
  const template = guidedAgentTemplates.find(({ id }) => id === "clinic_appointments")!;
  const result = buildGuidedAgent({
    templateId: template.id,
    answers: answersFor(template),
    mode: "external",
    language: "Hindi",
  });
  assert.match(result.prompt, /only after the tool returns success and a reference/i);
  assert.match(result.prompt, /do not diagnose/i);
  assert.match(result.prompt, /Speak Hindi/);
});

test("guided setup rejects missing business answers and invalid modes", () => {
  assert.throws(() => buildGuidedAgent({ templateId: "restaurant_reservations", answers: {}, mode: "collect" }), /Business name is required/);
  assert.throws(() => buildGuidedAgent({ templateId: "restaurant_reservations", answers: answersFor(guidedAgentTemplates[0]), mode: "unknown" as "collect" }), /Choose where business results should go/);
});

test("guided setup normalizes answers and allows an advanced prompt edit", () => {
  const result = buildGuidedAgent({
    templateId: "customer_feedback",
    answers: { ...answersFor(guidedAgentTemplates[6]), businessName: "Acme\nSupport" },
    mode: "digitalbot",
    promptOverride: "A concise custom instruction.",
  });
  assert.equal(result.answers.businessName, "Acme Support");
  assert.equal(result.prompt, "A concise custom instruction.");
  assert.match(result.generatedPrompt, /tool returns success/i);
});

test("connected guided agents need an enabled tool from the selected destination", () => {
  assert.doesNotThrow(() => assertGuidedIntegrationReady("collect", []));
  assert.throws(() => assertGuidedIntegrationReady("external", []), /Connect and enable/);
  assert.throws(() => assertGuidedIntegrationReady("external", [{ managedBy: "digitalbot" }]), /Connect and enable/);
  assert.doesNotThrow(() => assertGuidedIntegrationReady("external", [{ managedBy: "", enabled: true }]));
  assert.throws(() => assertGuidedIntegrationReady("digitalbot", [{ managedBy: "digitalbot", enabled: false }]), /Connect DigitalBot/);
  assert.doesNotThrow(() => assertGuidedIntegrationReady("digitalbot", [{ managedBy: "digitalbot", enabled: true }]));
});
