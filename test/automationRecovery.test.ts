import assert from "node:assert/strict";
import test from "node:test";
import { AutomationRunModel } from "../src/models/Automation.js";
import { recoverExpiredAutomationRuns } from "../src/services/automationRecoveryService.js";

test("expired external actions fail for operator review instead of replaying", async (context) => {
  const writes: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  context.mock.method(AutomationRunModel, "updateMany", async (filter, update) => {
    writes.push({ filter: filter as Record<string, unknown>, update: update as Record<string, unknown> });
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  });
  await recoverExpiredAutomationRuns(new Date("2026-01-01T00:00:00.000Z"));
  const uncertain = writes.find((write) => (write.update.$set as { status?: string })?.status === "failed");
  assert.ok(uncertain);
  assert.deepEqual((uncertain.filter.actionType as { $in: string[] }).$in, ["call", "whatsapp", "payment", "calendar", "crm", "notification"]);
  assert.match((uncertain.update.$set as { error: string }).error, /Check the provider/);
});
