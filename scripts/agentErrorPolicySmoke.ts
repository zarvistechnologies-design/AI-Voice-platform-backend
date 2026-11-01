import assert from "node:assert/strict";

import {
  agentErrorDisposition,
  serializeAgentError,
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

const providerError = Object.assign(new Error("WebSocket connection rejected"), {
  code: "WS_UPGRADE_FAILED",
  statusCode: 401,
  retryable: false,
  body: {
    error: { message: "Invalid authentication", type: "invalid_request_error" },
    authorization: "Bearer must-not-appear",
  },
});
const serialized = serializeAgentError({
  type: "stt_error",
  timestamp: 1793428216736,
  label: "openai.STT",
  error: providerError,
  recoverable: false,
});
assert.equal(serialized.type, "stt_error");
assert.equal(serialized.label, "openai.STT");
assert.equal(serialized.recoverable, false);
assert.deepEqual(serialized.error, {
  name: "Error",
  message: "WebSocket connection rejected",
  stack: providerError.stack,
  code: "WS_UPGRADE_FAILED",
  statusCode: 401,
  retryable: false,
  body: {
    error: { message: "Invalid authentication", type: "invalid_request_error" },
    authorization: "[redacted]",
  },
});

console.log("Agent error policy smoke tests passed.");
