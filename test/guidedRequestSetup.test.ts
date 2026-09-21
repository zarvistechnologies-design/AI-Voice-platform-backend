import assert from "node:assert/strict";
import test from "node:test";
import { buildGuidedAgent, clinicScheduleFields, guidedAgentTemplates } from "../src/services/guidedAgentTemplates.js";
import { assertManagedSetupReady, guidedAgentProvisioning } from "../src/services/guidedAgentProvisioningService.js";
import { guidedActionPolicy } from "../src/services/guidedActionPolicy.js";
import { nativeToolsForTemplate, nativeWorkflowDescription } from "../src/services/nativeWorkflowService.js";
import { executeWebhookTool } from "../src/services/agentToolService.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { NativeWorkflowRecordModel } from "../src/models/NativeWorkflowRecord.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { recordVerifiedToolBusinessEvent } from "../src/services/campaignBusinessEventService.js";

const ownerId = "test-workspace";
const agentId = "507f1f77bcf86cd799439011";
const context = { owner_id: ownerId, agent_id: agentId, call_id: "test-call" };

test("all seven businesses start with request capture using only the visible required details", () => {
  for (const template of guidedAgentTemplates) {
    const answers = Object.fromEntries(template.questions
      .filter((question) => question.requestRequired && !clinicScheduleFields.includes(question.id))
      .map(({ id }) => [id, id === "businessName" ? "Acme" : "Business details"]));
    const draft = buildGuidedAgent({ templateId: template.id, mode: "requests", answers,
      staffPhone: "+919876543210", staffEmail: "staff@example.com", timezone: "Asia/Kolkata" });
    const config = guidedAgentProvisioning({ templateId: template.id, mode: draft.mode, answers: draft.answers });
    assert.equal("nativeAppointments" in config, false, template.id);
    assert.ok(config.tools.some((tool) => tool.name === "create_staff_request"), template.id);
    assert.equal(config.callbackEmail, "staff@example.com");
    assert.equal(config.behavior.transferPhone, "+919876543210");
    assert.equal(config.businessHours.timezone, "Asia/Kolkata");
    assert.match(draft.prompt, /Automatic booking is not enabled/);
    assert.match(draft.prompt, /Never claim staff were notified unless delivery is verified/);
    assert.doesNotThrow(() => assertManagedSetupReady(template.id, "requests", config.tools));
    const agent = new VoiceAgentModel({ ownerId, name: draft.name, team: template.team, prompt: draft.prompt,
      firstMessage: draft.firstMessage, guidedSetup: { templateId: template.id, integrationMode: "requests", answers: draft.answers }, ...config });
    assert.equal(agent.validateSync(), undefined, template.id);
  }
});

test("activation rejects missing, disabled, or misdirected managed actions", () => {
  const tools = nativeToolsForTemplate("clinic_appointments", "requests");
  assert.throws(() => assertManagedSetupReady("clinic_appointments", "requests", tools.slice(0, 1)), /missing a required action/);
  assert.throws(() => assertManagedSetupReady("clinic_appointments", "requests", tools.map((tool) => ({ ...tool, enabled: false }))), /missing a required action/);
  assert.throws(() => assertManagedSetupReady("clinic_appointments", "requests", tools.map((tool) => ({ ...tool, url: "https://example.com/unrelated" }))), /missing a required action/);
});

test("staff contacts and timezone are validated before creation", () => {
  const template = guidedAgentTemplates[0];
  const answers = { businessName: "Acme", businessHours: "9 AM to 5 PM" };
  for (const fields of [{ staffPhone: "123" }, { staffEmail: "not-an-email" }, { timezone: "Invalid/Zone" }]) {
    assert.throws(() => buildGuidedAgent({ templateId: template.id, mode: "requests", answers, ...fields }));
  }
});

test("runtime policy corrects older native booking claims while retaining clinic slot booking", () => {
  for (const templateId of ["restaurant_reservations", "hotel_reservations", "service_booking", "real_estate_qualification"]) {
    assert.match(guidedActionPolicy(templateId, "native"), /staff must confirm/i);
    assert.match(guidedActionPolicy(templateId, "native"), /take precedence over older booking instructions/);
  }
  assert.match(guidedActionPolicy("clinic_appointments", "native"), /exact slotId/);
  assert.match(guidedActionPolicy("clinic_appointments", "requests"), /no appointment has been booked/);
  const oldTool = { ...nativeToolsForTemplate("hotel_reservations")[0], description: "Create a final hotel booking" };
  assert.match(nativeWorkflowDescription(oldTool) ?? "", /staff must confirm/);
});

test("booking tools persist pending requests and never generate verified booking events", async (t) => {
  const cases = [
    ["restaurant_reservations", { guestName: "Asha", phone: "+919876543210", date: "2027-01-20", time: "19:00", partySize: 4 }],
    ["clinic_appointments", { customerName: "Asha", phone: "+919876543210", preferredDate: "2027-01-20", preferredTime: "10:00" }],
    ["hotel_reservations", { guestName: "Asha", phone: "+919876543210", checkIn: "2027-01-20", checkOut: "2027-01-22", guestCount: 2 }],
    ["service_booking", { customerName: "Asha", phone: "+919876543210", serviceType: "Cleaning", serviceLocation: "Main Street", preferredDate: "2027-01-20", preferredTime: "10:00" }],
    ["real_estate_qualification", { name: "Asha", phone: "+919876543210", property: "Main Street", preferredDate: "2027-01-20", preferredTime: "10:00" }],
  ] as const;
  for (const [templateId, args] of cases) {
    const tools = nativeToolsForTemplate(templateId, "requests");
    const tool = tools.find((item) => item.name === "create_site_visit_request") ?? tools[0];
    const find = t.mock.method(VoiceAgentModel, "findOne", ((filter: Record<string, unknown>) => {
      assert.equal(filter.ownerId, ownerId);
      return { select: async () => ({ _id: agentId, guidedSetup: { templateId, integrationMode: "requests" }, tools }) };
    }) as typeof VoiceAgentModel.findOne);
    let persisted: Record<string, unknown> | undefined;
    const write = t.mock.method(NativeWorkflowRecordModel, "findOneAndUpdate", (async (_filter: unknown, update: { $setOnInsert: Record<string, unknown> }) => {
      persisted = update.$setOnInsert;
      return persisted;
    }) as typeof NativeWorkflowRecordModel.findOneAndUpdate);
    const result = await executeWebhookTool(tool, args, context);
    const body = JSON.parse(result.responseText);
    assert.equal(result.ok, true, templateId);
    assert.equal(body.success, true);
    assert.equal(body.recorded, true);
    assert.equal(body.confirmed, false);
    assert.equal(body.status, "pending_confirmation");
    assert.equal(persisted?.status, "pending_confirmation");
    assert.equal(persisted?.ownerId, ownerId);
    assert.equal(body.reference, persisted?.reference);
    assert.equal(await recordVerifiedToolBusinessEvent({ roomName: "test", toolName: tool.name, args, responseText: result.responseText }), null);
    find.mock.restore();
    write.mock.restore();
  }
});

test("saving a staff request handles incomplete details, retries, notifications, and storage failure", async (t) => {
  const tools = nativeToolsForTemplate("service_booking", "requests");
  const tool = tools.find((item) => item.name === "create_staff_request")!;
  t.mock.method(VoiceAgentModel, "findOne", (() => ({ select: async () => ({ _id: agentId, guidedSetup: { templateId: "service_booking", integrationMode: "requests" }, tools }) })) as typeof VoiceAgentModel.findOne);
  const records = new Map<string, Record<string, unknown>>();
  const write = t.mock.method(NativeWorkflowRecordModel, "findOneAndUpdate", (async (filter: { dedupeKey: string }, update: { $setOnInsert: Record<string, unknown> }) => {
    if (!records.has(filter.dedupeKey)) records.set(filter.dedupeKey, update.$setOnInsert);
    return records.get(filter.dedupeKey);
  }) as typeof NativeWorkflowRecordModel.findOneAndUpdate);
  const flag = t.mock.method(CallDetailRecordModel, "updateOne", (async () => ({})) as typeof CallDetailRecordModel.updateOne);
  const args = { request: "Change my cleaning appointment; I do not know the date yet." };
  const liveContext = { ...context, call_id: "507f1f77bcf86cd799439022" };
  const first = await executeWebhookTool(tool, args, liveContext);
  const retry = await executeWebhookTool(tool, args, liveContext);
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(first.responseText).reference, JSON.parse(retry.responseText).reference);
  assert.equal(records.size, 1);
  assert.equal(JSON.parse(first.responseText).status, "needs_review");
  assert.equal(JSON.parse(first.responseText).confirmed, false);
  assert.ok(flag.mock.callCount() > 0);
  assert.deepEqual(flag.mock.calls[0].arguments[0], { _id: liveContext.call_id, ownerId, agentId });
  assert.equal((flag.mock.calls[0].arguments[1] as { $set: Record<string, unknown> }).$set.callbackRequested, true);
  assert.equal((flag.mock.calls[0].arguments[1] as { $set: Record<string, unknown> }).$set["callbackDetails.reason"], args.request);
  const missing = await executeWebhookTool(tool, {}, context);
  assert.equal(missing.ok, false);
  assert.equal(records.size, 1);
  write.mock.mockImplementation(async () => { throw new Error("Storage unavailable"); });
  const failed = await executeWebhookTool(tool, args, context);
  assert.equal(failed.ok, false);
  assert.equal(JSON.parse(failed.responseText).success, false);
  assert.equal(JSON.parse(failed.responseText).reference, undefined);
});

test("a tool cannot save records for another workspace or an unconfigured action", async (t) => {
  const tool = nativeToolsForTemplate("service_booking", "requests")[0];
  const find = t.mock.method(VoiceAgentModel, "findOne", (() => ({ select: async () => null })) as typeof VoiceAgentModel.findOne);
  assert.equal((await executeWebhookTool(tool, {}, context)).status, 409);
  find.mock.mockImplementation((() => ({ select: async () => ({ _id: agentId, guidedSetup: { templateId: "service_booking", integrationMode: "requests" }, tools: [] }) })) as typeof VoiceAgentModel.findOne);
  assert.equal((await executeWebhookTool(tool, {}, context)).status, 409);
});
