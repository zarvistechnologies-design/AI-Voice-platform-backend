import assert from "node:assert/strict";
import test from "node:test";

import { eventTypeForTool } from "../src/services/campaignBusinessEventService.js";

test("confirmed native site visits count as appointments", () => {
  assert.equal(eventTypeForTool("create_site_visit_request"), "appointment");
});

test("promises and disputes do not count as verified payments", () => {
  assert.equal(eventTypeForTool("record_payment_promise"), null);
  assert.equal(eventTypeForTool("record_payment_dispute"), null);
  assert.equal(eventTypeForTool("collect_payment"), "payment");
  assert.equal(eventTypeForTool("create_invoice"), null);
  assert.equal(eventTypeForTool("lookup_order"), null);
});
