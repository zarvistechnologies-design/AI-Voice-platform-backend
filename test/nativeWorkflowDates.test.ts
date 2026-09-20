import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkflowData } from "../src/services/nativeWorkflowService.js";

test("native booking rejects impossible dates instead of confirming them", () => {
  assert.throws(() => validateWorkflowData("hotel_booking", { checkIn: "2026-02-30", checkOut: "2026-03-01" }), /valid date/);
  assert.throws(() => validateWorkflowData("site_visit", { preferredDate: "2026-13-01" }), /valid date/);
  assert.doesNotThrow(() => validateWorkflowData("hotel_booking", { checkIn: "2028-02-29", checkOut: "2028-03-01" }));
});
