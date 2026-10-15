import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";

import { env } from "../src/config/env.js";
import { outboundTrunkIdForProvider, inferredLiveKitSipUri } from "../src/services/livekitService.js";
import { handleTwilioVoiceWebhook } from "../src/controllers/voiceController.js";

test("outboundTrunkIdForProvider resolves correctly for Twilio", () => {
  // Stored trunk takes precedence
  assert.equal(outboundTrunkIdForProvider("Twilio", "ST_custom_twilio_123"), "ST_custom_twilio_123");
  assert.equal(outboundTrunkIdForProvider("twilio", "ST_custom_twilio_456"), "ST_custom_twilio_456");

  // Fallback to configured twilio trunk id or livekit trunk id
  const fallback = outboundTrunkIdForProvider("Twilio", "");
  const expectedFallback = env.twilioSipOutboundTrunkId || env.livekitSipOutboundTrunkId;
  assert.equal(fallback, expectedFallback);
});

test("inferredLiveKitSipUri resolves to a valid SIP host", () => {
  const uri = inferredLiveKitSipUri();
  assert.ok(typeof uri === "string");
  // Should not have double sip: prefix
  assert.ok(!uri.startsWith("sip:sip:"));
});

test("handleTwilioVoiceWebhook returns TwiML dialing LiveKit SIP URI", async () => {
  let responseBody = "";
  let responseType = "";

  const mockReq = {
    body: {
      To: "+12025550123",
      From: "+12025550199",
      CallSid: "CA1234567890abcdef",
    },
    query: {},
  } as unknown as Request;

  const mockRes = {
    type(t: string) {
      responseType = t;
      return this;
    },
    send(data: string) {
      responseBody = data;
      return this;
    },
  } as unknown as Response;

  await handleTwilioVoiceWebhook(mockReq, mockRes);

  assert.equal(responseType, "text/xml");
  assert.ok(responseBody.includes("<Response>"), "Response should contain <Response>");
  assert.ok(responseBody.includes("<Dial"), "Response should contain <Dial");
  assert.ok(responseBody.includes("answerOnBridge=\"true\""), "Dial should include answerOnBridge");
  assert.ok(responseBody.includes("callerId=\"+12025550199\""), "Dial should include callerId");
  assert.ok(responseBody.includes("<Sip>"), "Dial should wrap a <Sip> tag");
  assert.ok(responseBody.includes("%2B12025550123"), "Sip URI should contain URL-encoded destination phone number");
});
