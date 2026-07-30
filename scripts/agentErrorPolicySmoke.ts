import assert from "node:assert/strict";

import {
  agentErrorDisposition,
  shouldFailCallFromSessionClose,
} from "../src/services/agentErrorPolicy.js";

assert.equal(
  agentErrorDisposition({ type: "llm_error", recoverable: true }),
  "retrying",
  "A retryable empty Gemini response must not fail the call",
);
assert.equal(
  agentErrorDisposition({ type: "llm_error", recoverable: false }),
  "session_managed",
  "The AgentSession threshold, not an intermediate event, owns fatality",
);
assert.equal(shouldFailCallFromSessionClose(null), false);
assert.equal(shouldFailCallFromSessionClose(undefined), false);
assert.equal(shouldFailCallFromSessionClose(new Error("provider exhausted retries")), true);

console.log("Agent error policy smoke tests passed.");
