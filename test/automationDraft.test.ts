import assert from "node:assert/strict";
import test from "node:test";
import { buildAutomationDraftFromPrompt } from "../src/services/automationDraftService.js";
import { validateAutomation } from "../src/services/automationDefinitionService.js";

const defaults = { agentId: "auto", phoneNumberId: "auto", templateName: "" };

test("fallback drafts only the requested actions and leaves consent unconfirmed", async () => {
  const draft = buildAutomationDraftFromPrompt("When a missed call arrives, call back and update CRM", defaults);
  assert.deepEqual(draft.graph.nodes.filter((node) => node.type !== "end").map((node) => node.type), ["trigger", "call", "crm"]);
  assert.equal(draft.graph.nodes[0].config.consentConfirmed, "false");
  assert.ok(draft.graph.edges.some((edge) => edge.source === "step_1" && edge.sourceHandle === "failed"));
  const structuralIssues = await validateAutomation("workspace", draft.graph);
  assert.ok(!structuralIssues.some((issue) => /branch|connection|cycle|reachable/i.test(issue.message)));
});

test("fallback drafts a Slack-only workflow without unrelated paid actions", async () => {
  const draft = buildAutomationDraftFromPrompt("When a campaign lead is imported, notify team in Slack", defaults);
  assert.deepEqual(draft.graph.nodes.map((node) => node.type), ["trigger", "sms", "end"]);
  assert.equal(draft.graph.nodes[0].config.campaignId, "all");
  assert.deepEqual(await validateAutomation("workspace", draft.graph), []);
});
