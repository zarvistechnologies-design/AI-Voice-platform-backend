import assert from "node:assert/strict";
import test from "node:test";

import { assertGuidedIntegrationReady, buildGuidedAgent, guidedAgentTemplates, nativeClinicConfig } from "../src/services/guidedAgentTemplates.js";
import { nativeClinicAppointmentTools } from "../src/services/nativeAppointmentService.js";
import { nativeToolsForTemplate } from "../src/services/nativeWorkflowService.js";
import { executeWebhookTool } from "../src/services/agentToolService.js";
import { NativeAppointmentModel } from "../src/models/NativeAppointment.js";
import { guidedAgentProvisioning } from "../src/services/guidedAgentProvisioningService.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

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
  assert.throws(() => assertGuidedIntegrationReady("native", []), /Restore the Vozon managed tools/);
  assert.doesNotThrow(() => assertGuidedIntegrationReady("native", [{ managedBy: "vozon", enabled: true }]));
});

test("service booking provisioning never runs the clinic doctor validator", () => {
  const template = guidedAgentTemplates.find(({ id }) => id === "service_booking")!;
  const answers = {
    ...answersFor(template),
    businessName: "Tank Cleaning",
    businessHours: "9 AM to 6 PM, Asia/Kolkata",
    handoff: "When the caller asks for staff",
    services: "Tank cleaning and toilet cleaning",
    serviceRules: "₹200 tank cleaning and ₹100 toilet cleaning",
  };
  const draft = buildGuidedAgent({ templateId: template.id, answers, mode: "native", name: "Sumit Rathore" });
  const provisioning = guidedAgentProvisioning({ templateId: draft.template.id, mode: draft.mode, answers: draft.answers });
  assert.equal("nativeAppointments" in provisioning, false);
  assert.deepEqual(provisioning.tools.map((tool) => tool.name), ["create_service_booking_request"]);
});

test("only the clinic template receives native appointment configuration", () => {
  for (const template of guidedAgentTemplates.filter(({ id }) => id !== "clinic_appointments")) {
    const draft = buildGuidedAgent({ templateId: template.id, answers: answersFor(template), mode: "native" });
    const provisioning = guidedAgentProvisioning({ templateId: template.id, mode: draft.mode, answers: draft.answers });
    assert.equal("nativeAppointments" in provisioning, false, template.id);
  }
});

test("all seven native template drafts validate as VoiceAgent records", () => {
  for (const template of guidedAgentTemplates) {
    const answers = answersFor(template);
    if (template.id === "clinic_appointments") Object.assign(answers, {
      providers: "Dr Mehta", appointmentTimezone: "Asia/Kolkata", bookingDays: "Mon,Tue,Wed,Thu,Fri",
      bookingStart: "09:00", bookingEnd: "17:00", appointmentDuration: "30",
    });
    const draft = buildGuidedAgent({ templateId: template.id, answers, mode: "native" });
    const provisioning = guidedAgentProvisioning({ templateId: template.id, mode: draft.mode, answers: draft.answers });
    const agent = new VoiceAgentModel({
      ownerId: "test-organization", name: draft.name, team: draft.template.team,
      prompt: draft.prompt, firstMessage: draft.firstMessage,
      guidedSetup: { templateId: template.id, integrationMode: draft.mode, answers: draft.answers },
      ...provisioning,
    });
    assert.equal(agent.validateSync(), undefined, template.id);
  }
});

test("clinic native mode creates a structured schedule and managed booking tools", () => {
  const template = guidedAgentTemplates.find(({ id }) => id === "clinic_appointments")!;
  const answers = {
    ...answersFor(template), providers: "Dr Mehta, Dr Shah", appointmentTimezone: "Asia/Kolkata",
    bookingDays: "Mon,Tue,Wed,Thu,Fri,Sat", bookingStart: "09:00", bookingEnd: "17:00", appointmentDuration: "30",
  };
  const result = buildGuidedAgent({ templateId: template.id, answers, mode: "native" });
  const config = nativeClinicConfig(result.answers);
  const tools = nativeClinicAppointmentTools();
  assert.deepEqual(config.providers, ["Dr Mehta", "Dr Shah"]);
  assert.deepEqual(config.weekdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(config.durationMinutes, 30);
  assert.deepEqual(tools.map((tool) => tool.name), ["check_appointment_availability", "book_appointment"]);
  assert.ok(tools.every((tool) => tool.managedBy === "vozon"));
  assert.match(result.prompt, /exact slotId/i);
});

test("native appointment tools dispatch inside Vozon and the booking slot has a database uniqueness guard", async () => {
  const availability = nativeClinicAppointmentTools()[0];
  const result = await executeWebhookTool(availability, { date: "2026-10-01" });
  assert.equal(result.status, 400);
  assert.match(result.responseText, /context is missing/i);
  const slotIndex = NativeAppointmentModel.schema.indexes().find(([keys]) =>
    keys.agentId === 1 && keys.providerKey === 1 && keys.startAt === 1,
  );
  assert.equal(slotIndex?.[1]?.unique, true);
  assert.deepEqual(slotIndex?.[1]?.partialFilterExpression, { status: "booked" });
});

test("every guided template has automatically managed Vozon tools", () => {
  for (const template of guidedAgentTemplates) {
    const tools = nativeToolsForTemplate(template.id);
    assert.ok(tools.length > 0, `${template.id} should have at least one native tool`);
    assert.ok(tools.every((tool) => tool.managedBy === "vozon"));
    const answers = answersFor(template);
    if (template.id === "clinic_appointments") Object.assign(answers, {
      providers: "Dr Mehta", appointmentTimezone: "Asia/Kolkata", bookingDays: "Mon,Tue,Wed,Thu,Fri",
      bookingStart: "09:00", bookingEnd: "17:00", appointmentDuration: "30",
    });
    const result = buildGuidedAgent({ templateId: template.id, answers, mode: "native" });
    assert.equal(result.mode, "native");
  }
});

test("non-clinic native tools dispatch locally and prompts preserve pending confirmation boundaries", async () => {
  const tools = nativeToolsForTemplate("restaurant_reservations");
  const result = await executeWebhookTool(tools[0], {
    guestName: "Asha", phone: "+919876543210", date: "2026-10-02", time: "19:00", partySize: 4,
  });
  assert.equal(result.status, 400);
  assert.match(result.responseText, /context is missing/i);
  const template = guidedAgentTemplates.find(({ id }) => id === "restaurant_reservations")!;
  const draft = buildGuidedAgent({ templateId: template.id, answers: answersFor(template), mode: "native" });
  assert.match(draft.prompt, /staff must confirm table availability/i);
  assert.match(draft.prompt, /never call it a confirmed reservation/i);
});
