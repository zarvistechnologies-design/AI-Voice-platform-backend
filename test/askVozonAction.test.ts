import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

import { env } from "../src/config/env.js";
import { AssistantPendingActionModel } from "../src/models/AssistantPendingAction.js";
import { CampaignLeadModel } from "../src/models/CampaignLead.js";
import { CampaignModel } from "../src/models/Campaign.js";
import { ContactSuppressionModel } from "../src/models/ContactSuppression.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { decideAssistantAction, parseAssistantWriteAction, proposeAssistantAction } from "../src/services/assistantActionService.js";
import { askVozonAssistant } from "../src/services/assistantService.js";
import { HttpError } from "../src/utils/httpError.js";

test("Ask Vozon previews agent creation and saves only after a single approval", async () => {
  const ownerId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const actionId = new Types.ObjectId();
  const argumentsValue = { name: "Support", prompt: "Answer support questions clearly.", firstMessage: "Hello, how can I help?" };
  const expiresAt = new Date(Date.now() + 600_000);
  const pendingModel = AssistantPendingActionModel as unknown as {
    create: (value: Record<string, unknown>) => Promise<any>;
    findOneAndUpdate: (...args: unknown[]) => Promise<any>;
    updateOne: (...args: unknown[]) => Promise<any>;
  };
  const agentModel = VoiceAgentModel as unknown as { create: (value: Record<string, unknown>) => Promise<any> };
  const previousPendingCreate = pendingModel.create;
  const previousFind = pendingModel.findOneAndUpdate;
  const previousUpdate = pendingModel.updateOne;
  const previousAgentCreate = agentModel.create;
  const previousFetch = globalThis.fetch;
  const previousApiKey = env.openaiApiKey;
  const previousWhiteLabelEnabled = env.whiteLabelEnabled;
  let agentCreates = 0;
  let decisions = 0;

  try {
    env.openaiApiKey = "test-key";
    env.whiteLabelEnabled = false;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "create_agent", arguments: JSON.stringify(argumentsValue) } }],
    } }] }), { status: 200, headers: { "content-type": "application/json" } });
    pendingModel.create = async (value) => ({ _id: actionId, ...value });
    pendingModel.findOneAndUpdate = async () => (++decisions === 1
      ? { _id: actionId, ownerId, userId, toolName: "create_agent", arguments: argumentsValue, expiresAt }
      : null);
    pendingModel.updateOne = async () => ({ matchedCount: 1 });
    agentModel.create = async (value) => {
      agentCreates += 1;
      return { _id: new Types.ObjectId(), ...value };
    };

    const proposal = await askVozonAssistant(ownerId, [{ role: "user", content: "Create a support agent" }], { userId, role: "owner" });
    assert.equal(agentCreates, 0);
    assert.equal(proposal.pendingAction?.title, "Create Support");
    assert.equal(proposal.pendingAction?.id, actionId.toString());

    const approved = await decideAssistantAction(ownerId, userId, actionId.toString(), true);
    assert.match(approved.answer, /created in Draft status/i);
    assert.equal(agentCreates, 1);
    await assert.rejects(() => decideAssistantAction(ownerId, userId, actionId.toString(), true),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409);
    assert.equal(agentCreates, 1);
  } finally {
    pendingModel.create = previousPendingCreate;
    pendingModel.findOneAndUpdate = previousFind;
    pendingModel.updateOne = previousUpdate;
    agentModel.create = previousAgentCreate;
    globalThis.fetch = previousFetch;
    env.openaiApiKey = previousApiKey;
    env.whiteLabelEnabled = previousWhiteLabelEnabled;
  }
});

test("Ask Vozon rejects incomplete or unexpected write arguments", () => {
  assert.throws(() => parseAssistantWriteAction("update_agent", JSON.stringify({ agentNameOrId: "Sales" })), HttpError);
  assert.throws(() => parseAssistantWriteAction("create_agent", JSON.stringify({ name: "Sales", ownerId: "another-workspace" })), HttpError);
  assert.throws(() => parseAssistantWriteAction("schedule_follow_up", JSON.stringify({ leadId: new Types.ObjectId().toString(), scheduledAt: "2026-11-01T10:00:00" })), HttpError);
});

test("Ask Vozon does not propose a follow-up for an opted-out contact", async () => {
  const ownerId = new Types.ObjectId().toString();
  const leadId = new Types.ObjectId();
  const campaignId = new Types.ObjectId();
  const leadModel = CampaignLeadModel as unknown as { findOne: (...args: unknown[]) => any };
  const campaignModel = CampaignModel as unknown as { findOne: (...args: unknown[]) => any };
  const suppressionModel = ContactSuppressionModel as unknown as { exists: (...args: unknown[]) => Promise<any> };
  const pendingModel = AssistantPendingActionModel as unknown as { create: (...args: unknown[]) => Promise<any> };
  const previousLead = leadModel.findOne;
  const previousCampaign = campaignModel.findOne;
  const previousSuppression = suppressionModel.exists;
  const previousCreate = pendingModel.create;
  let created = false;

  try {
    leadModel.findOne = () => ({ select: () => ({ lean: async () => ({ _id: leadId, campaignId, name: "Pat", phone: "+919999999999" }) }) });
    campaignModel.findOne = () => ({ select: () => ({ lean: async () => ({ _id: campaignId, name: "October", status: "running", automaticCallbacks: true, timezone: "Asia/Kolkata", windowStart: "09:00", windowEnd: "18:00" }) }) });
    suppressionModel.exists = async () => ({ _id: new Types.ObjectId() });
    pendingModel.create = async () => { created = true; return null; };
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(tomorrow));
    const offsetHours = (11 - localHour + 24) % 24;
    const scheduledAt = new Date(tomorrow.getTime() + offsetHours * 60 * 60_000).toISOString();
    await assert.rejects(
      () => proposeAssistantAction(ownerId, "user", "schedule_follow_up", JSON.stringify({ leadId: leadId.toString(), scheduledAt })),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409 && /opted out/i.test(error.message),
    );
    assert.equal(created, false);
  } finally {
    leadModel.findOne = previousLead;
    campaignModel.findOne = previousCampaign;
    suppressionModel.exists = previousSuppression;
    pendingModel.create = previousCreate;
  }
});
