import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";

import { env } from "../src/config/env.js";
import { outboundTrunkIdForProvider } from "../src/services/livekitService.js";
import { handlePlivoVoiceWebhook } from "../src/controllers/voiceController.js";

test("outboundTrunkIdForProvider resolves correctly for Plivo", () => {
  // Stored trunk takes precedence
  assert.equal(outboundTrunkIdForProvider("Plivo", "ST_custom_plivo_123"), "ST_custom_plivo_123");
  assert.equal(outboundTrunkIdForProvider("plivo", "ST_custom_plivo_456"), "ST_custom_plivo_456");
  assert.equal(outboundTrunkIdForProvider("plivio", "ST_custom_plivio_789"), "ST_custom_plivio_789");

  // Fallback to configured plivo trunk id or livekit trunk id
  const fallback = outboundTrunkIdForProvider("Plivo", "");
  const expectedFallback = env.plivoSipOutboundTrunkId || env.livekitSipOutboundTrunkId;
  assert.equal(fallback, expectedFallback);
});

test("handlePlivoVoiceWebhook returns Plivo XML dialing LiveKit SIP URI", async () => {
  let responseBody = "";
  let responseType = "";

  const mockReq = {
    body: {
      To: "+14155550123",
      From: "+14155550199",
      CallUUID: "plivo-call-uuid-12345",
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

  await handlePlivoVoiceWebhook(mockReq, mockRes);

  assert.equal(responseType, "text/xml");
  assert.ok(responseBody.includes("<Response>"), "Response should contain <Response>");
  assert.ok(responseBody.includes("<Dial"), "Response should contain <Dial");
  assert.ok(responseBody.includes('callerId="+14155550199"'), "Dial should include callerId");
  assert.ok(responseBody.includes("<User>"), "Dial should wrap a <User> tag for Plivo SIP forwarding");
  assert.ok(responseBody.includes("+14155550123"), "Sip URI should contain destination phone number");
});
