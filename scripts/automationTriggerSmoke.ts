import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { AutomationModel, AutomationRunModel, AutomationWhatsAppStatusModel } from "../src/models/Automation.js";
import { CampaignLeadModel } from "../src/models/CampaignLead.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../src/models/ContactSuppression.js";
import { processAutomationRuns } from "../src/services/automationRuntimeService.js";
import { processAutomationTriggers } from "../src/services/automationTriggerService.js";
import { recordAutomationWhatsAppStatuses } from "../src/services/automationWhatsAppStatusService.js";

const dbName = `vzn_trigger_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
const ownerId = new mongoose.Types.ObjectId().toString();
const campaignId = new mongoose.Types.ObjectId();
const inboundNumberId = new mongoose.Types.ObjectId();
const earlier = new Date(Date.now() - 60_000);
const graph = (event: string, config: Record<string, string>) => ({
  schemaVersion: 1,
  nodes: [
    { id: "start", type: "trigger", title: "Start", x: 0, y: 0, config: { event, ...config } },
    { id: "end", type: "end", title: "End", x: 300, y: 0, config: {} },
  ],
  edges: [{ id: "next", source: "start", target: "end", sourceHandle: "default" }],
});

async function main() {
  let connected = false;
  try {
    await mongoose.connect(env.mongodbUri, { dbName, serverSelectionTimeoutMS: 15_000 });
    connected = true;
    await AutomationRunModel.init();
    await AutomationWhatsAppStatusModel.init();
    const leadFlow = await AutomationModel.create({
      ownerId, name: "Lead follow-up", createdBy: ownerId, status: "live",
      publishedVersion: 1, publishedAt: earlier,
      draft: graph("contact_added", { campaignId: "all" }),
      published: graph("contact_added", { campaignId: "all" }),
    });
    const missedFlow = await AutomationModel.create({
      ownerId, name: "Missed inbound", createdBy: ownerId, status: "live",
      publishedVersion: 1, publishedAt: earlier,
      draft: graph("missed_call", { phoneNumberId: inboundNumberId.toString(), consentConfirmed: "true" }),
      published: graph("missed_call", { phoneNumberId: inboundNumberId.toString(), consentConfirmed: "true" }),
    });
    const now = new Date();
    const leads = await CampaignLeadModel.collection.insertMany([
      { ownerId, campaignId, phone: "+15555550101", name: "Consented", automationConsentConfirmed: true, status: "queued", createdAt: now },
      { ownerId, campaignId, phone: "+15555550102", name: "No consent", automationConsentConfirmed: false, status: "queued", createdAt: now },
      { ownerId, campaignId, phone: "+15555550103", name: "Suppressed", automationConsentConfirmed: true, status: "suppressed", createdAt: now },
    ]);
    const calls = await CallDetailRecordModel.collection.insertMany([
      { ownerId, agentId: new mongoose.Types.ObjectId(), phoneNumberId: inboundNumberId, direction: "inbound", status: "completed", livekitRoomName: "smoke-missed", callerNumber: "+15555550201", terminalFinalizedAt: now, startedAt: null, transcript: [] },
      { ownerId, agentId: new mongoose.Types.ObjectId(), phoneNumberId: inboundNumberId, direction: "inbound", status: "completed", livekitRoomName: "smoke-answered", callerNumber: "+15555550202", terminalFinalizedAt: now, startedAt: now, transcript: [{ role: "user", text: "Hello" }] },
    ]);
    await processAutomationTriggers();
    await processAutomationTriggers();
    let runs = await AutomationRunModel.find({ ownerId }).lean();
    assert.equal(runs.length, 2, "only consented and missed contacts should start");
    assert.ok(runs.some((run) => run.automationId.equals(leadFlow._id) && run.eventId === `lead:${leads.insertedIds[0]}`));
    assert.ok(runs.some((run) => run.automationId.equals(missedFlow._id) && run.eventId === `missed:${calls.insertedIds[0]}`));
    await processAutomationRuns(10);
    runs = await AutomationRunModel.find({ ownerId }).lean();
    assert.ok(runs.every((run) => run.status === "completed" && run.steps.length === 2));
    await ContactSuppressionModel.collection.insertOne({ ownerId, phone: "+15555550104", reason: "opt out" });
    await CampaignLeadModel.collection.insertOne({ ownerId, campaignId, phone: "+15555550104", automationConsentConfirmed: true, status: "queued", createdAt: new Date() });
    await processAutomationTriggers();
    assert.equal(await AutomationRunModel.countDocuments({ ownerId }), 2, "suppressed contact must not start");
    const deliveryGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "message", type: "whatsapp", title: "Message", x: 0, y: 0, config: { templateName: "test", language: "en_US" } },
        { id: "end", type: "end", title: "End", x: 300, y: 0, config: {} },
      ],
      edges: [{ id: "next", source: "message", target: "end", sourceHandle: "default" }],
    };
    const deliveryFlow = await AutomationModel.create({ ownerId, name: "Delivery", createdBy: ownerId, draft: deliveryGraph });
    const deliveryRun = await AutomationRunModel.create({
      ownerId, automationId: deliveryFlow._id, version: 1, graph: deliveryGraph, eventId: "delivery-smoke",
      contactPhone: "+15555550301", status: "waiting", currentNodeId: "message",
      waitKind: "whatsapp_delivery", dueAt: new Date(Date.now() - 1000), whatsappMessageId: "wamid.smoke-delivered", whatsappSentAt: now,
      context: { consentConfirmed: true },
    });
    await recordAutomationWhatsAppStatuses({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { statuses: [
      { id: "wamid.smoke-delivered", status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)) },
      { id: "wamid.smoke-delivered", status: "sent", timestamp: String(Math.floor(Date.now() / 1000) - 1) },
    ] } }] }] });
    assert.equal((await AutomationWhatsAppStatusModel.findOne({ messageId: "wamid.smoke-delivered" }))?.status, "delivered", "late provider events must not regress delivery state");
    await processAutomationRuns(5);
    assert.equal((await AutomationRunModel.findById(deliveryRun._id))?.status, "completed");
    const failedRun = await AutomationRunModel.create({
      ownerId, automationId: deliveryFlow._id, version: 1, graph: deliveryGraph, eventId: "failed-delivery-smoke",
      contactPhone: "+15555550302", status: "waiting", currentNodeId: "message",
      waitKind: "whatsapp_delivery", dueAt: new Date(Date.now() - 1000), whatsappMessageId: "wamid.smoke-failed", whatsappSentAt: now,
      context: { consentConfirmed: true },
    });
    await recordAutomationWhatsAppStatuses({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { statuses: [
      { id: "wamid.smoke-failed", status: "failed", errors: [{ title: "Undeliverable" }] },
    ] } }] }] });
    await processAutomationRuns(5);
    assert.equal((await AutomationRunModel.findById(failedRun._id))?.status, "failed");
    console.log("Automation trigger smoke passed: consent, missed calls, dedupe, suppression, WhatsApp delivery and failure.");
  } finally {
    await mongoose.disconnect();
    if (connected && /^vzn_trigger_[0-9a-f]{22}$/.test(dbName)) {
      const cleanup = new mongoose.mongo.MongoClient(env.mongodbUri, { serverSelectionTimeoutMS: 15_000 });
      try {
        await cleanup.connect();
        await cleanup.db(dbName).dropDatabase();
        console.log("Temporary trigger smoke database removed.");
      } finally { await cleanup.close(); }
    }
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
