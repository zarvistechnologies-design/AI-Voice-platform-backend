import assert from "node:assert/strict";
import test from "node:test";

import { assistantToolDefinitions, runAssistantTool } from "../src/services/assistantToolService.js";
import { HttpError } from "../src/utils/httpError.js";

test("Ask Vozon tool definitions expose all workspace and transcript tools correctly", () => {
  const toolNames = assistantToolDefinitions.map((t) => t.function.name);
  assert.ok(toolNames.includes("get_recent_calls"), "get_recent_calls should be defined");
  assert.ok(toolNames.includes("get_call_summary"), "get_call_summary should be defined");
  assert.ok(toolNames.includes("list_agents"), "list_agents should be defined");
  assert.ok(toolNames.includes("create_agent"), "create_agent should be defined");
  assert.ok(toolNames.includes("get_call_transcript"), "get_call_transcript should be defined");
  assert.ok(toolNames.includes("get_call_details"), "get_call_details should be defined");
  assert.ok(toolNames.includes("get_agent_details"), "get_agent_details should be defined");
  assert.ok(toolNames.includes("update_agent"), "update_agent should be defined");
  assert.ok(toolNames.includes("list_phone_numbers"), "list_phone_numbers should be defined");
  for (const name of ["list_campaigns", "get_campaign_performance", "get_follow_up_candidates", "get_agent_performance", "search_agent_knowledge"]) {
    assert.ok(toolNames.includes(name), `${name} should be available to Ask Vozon`);
  }

  const transcriptTool = assistantToolDefinitions.find((t) => t.function.name === "get_call_transcript");
  assert.ok(transcriptTool, "get_call_transcript tool should exist");
  assert.match(transcriptTool.function.description, /transcript/i);

  const createAgentTool = assistantToolDefinitions.find((t) => t.function.name === "create_agent");
  assert.ok(createAgentTool, "create_agent tool should exist");
  assert.ok(createAgentTool.function.parameters.required.includes("name"));

  const getAgentDetailsTool = assistantToolDefinitions.find((t) => t.function.name === "get_agent_details");
  assert.ok(getAgentDetailsTool, "get_agent_details tool should exist");
  assert.ok(getAgentDetailsTool.function.parameters.required.includes("agentNameOrId"));

  const updateAgentTool = assistantToolDefinitions.find((t) => t.function.name === "update_agent");
  assert.ok(updateAgentTool, "update_agent tool should exist");
  assert.ok(updateAgentTool.function.parameters.required.includes("agentNameOrId"));

  const recentCallsTool = assistantToolDefinitions.find((t) => t.function.name === "get_recent_calls");
  assert.ok(recentCallsTool, "get_recent_calls tool should exist");
  assert.match(recentCallsTool.function.description, /last N calls/i);
  assert.strictEqual(recentCallsTool.function.parameters.properties.limit.minimum, 1);
  assert.strictEqual(recentCallsTool.function.parameters.properties.limit.maximum, 50);

  const callSummaryTool = assistantToolDefinitions.find((t) => t.function.name === "get_call_summary");
  assert.ok(callSummaryTool, "get_call_summary tool should exist");
  assert.match(callSummaryTool.function.description, /days/i);
  assert.strictEqual(callSummaryTool.function.parameters.properties.days.minimum, 1);
  assert.strictEqual(callSummaryTool.function.parameters.properties.days.maximum, 90);
});

test("runAssistantTool validates argument ranges and handles empty arguments", async () => {
  const fakeOrgId = "507f1f77bcf86cd799439011";

  // Invalid limit (> 50)
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "get_recent_calls", JSON.stringify({ limit: 100 })),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("between 1 and 50"),
  );

  // Invalid limit (< 1)
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "get_recent_calls", JSON.stringify({ limit: 0 })),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("between 1 and 50"),
  );

  // Invalid summary days (> 90)
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "get_call_summary", JSON.stringify({ days: 120 })),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("1 to 90 days"),
  );

  // Invalid summary days (< 1)
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "get_call_summary", JSON.stringify({ days: 0 })),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("1 to 90 days"),
  );

  // Missing agentNameOrId for get_agent_details
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "get_agent_details", JSON.stringify({})),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("agent name or ID is required"),
  );

  // Missing agentNameOrId for update_agent
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "update_agent", JSON.stringify({})),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400 && err.message.includes("agent name or ID is required"),
  );

  // Non-existent tool
  await assert.rejects(
    async () => runAssistantTool(fakeOrgId, "unknown_tool", "{}"),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400,
  );
});

test("runAssistantTool requires valid workspace organizationId", async () => {
  await assert.rejects(
    async () => runAssistantTool("invalid-org-id", "get_recent_calls", "{}"),
    (err: unknown) => err instanceof HttpError && err.statusCode === 401,
  );
});

test("chatSchema enforces user 2,000 max and assistant 8,000 max length limits", async () => {
  const { chatSchema } = await import("../src/controllers/assistantController.js");

  // Valid conversation with a long assistant response (e.g. 5,000 chars)
  const validResult = chatSchema.safeParse({
    messages: [
      { role: "user", content: "Show my last 15 calls" },
      { role: "assistant", content: "A".repeat(5000) },
      { role: "user", content: "Thanks" },
    ],
  });
  assert.ok(validResult.success, "Should accept assistant messages up to 8,000 chars");

  // User message over 2,000 chars is rejected
  const userTooLong = chatSchema.safeParse({
    messages: [{ role: "user", content: "B".repeat(2001) }],
  });
  assert.strictEqual(userTooLong.success, false, "Should reject user messages exceeding 2,000 chars");

  // Assistant message over 8,000 chars is rejected
  const assistantTooLong = chatSchema.safeParse({
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "C".repeat(8001) },
    ],
  });
  assert.strictEqual(assistantTooLong.success, false, "Should reject assistant messages exceeding 8,000 chars");

  // Empty content is rejected
  const emptyMessage = chatSchema.safeParse({
    messages: [{ role: "user", content: "   " }],
  });
  assert.strictEqual(emptyMessage.success, false, "Should reject whitespace or empty message");
});
