import assert from "node:assert/strict";

import { ParticipantInfo_Kind } from "@livekit/protocol";

import {
  isOutboundCallerParticipant,
  shouldActivateCallOnParticipantJoin,
} from "../src/controllers/livekitWebhookController.js";

const outboundRoom = "outbound-call-owner-test";

assert.equal(
  shouldActivateCallOnParticipantJoin(outboundRoom, {
    identity: "voice-platform-agent",
    kind: ParticipantInfo_Kind.AGENT,
  }),
  false,
  "The AI worker joining must not start outbound connected duration.",
);

assert.equal(
  shouldActivateCallOnParticipantJoin(outboundRoom, {
    identity: "phone-919876543210-1",
    kind: ParticipantInfo_Kind.STANDARD,
  }),
  false,
  "A phone participant joining without answer confirmation must not start duration.",
);

for (const status of ["dialing", "ringing", "automation", "hangup", "active"]) {
  assert.equal(
    shouldActivateCallOnParticipantJoin(outboundRoom, {
      identity: "phone-919876543210-1",
      kind: ParticipantInfo_Kind.SIP,
      attributes: { "sip.callStatus": status },
    }),
    status === "active",
    `Outbound join with SIP status ${status} must use answer confirmation.`,
  );
}

assert.equal(
  isOutboundCallerParticipant(outboundRoom, {
    identity: "sip-caller",
    kind: ParticipantInfo_Kind.SIP,
  }),
  true,
  "A SIP participant must be recognized as the outbound caller, even before answer.",
);

assert.equal(
  shouldActivateCallOnParticipantJoin("inbound-test", {
    identity: "sip-caller",
    kind: ParticipantInfo_Kind.SIP,
  }),
  false,
  "Inbound activation remains owned by the authoritative agent worker.",
);

assert.equal(
  shouldActivateCallOnParticipantJoin("web-call-test", {
    identity: "browser-user",
    kind: ParticipantInfo_Kind.STANDARD,
  }),
  true,
  "Web callers retain the existing participant-join activation behavior.",
);

console.log("LiveKit webhook activation policy smoke tests passed.");
