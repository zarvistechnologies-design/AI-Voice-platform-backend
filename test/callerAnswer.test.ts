import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ParticipantKind, RoomEvent, type RemoteParticipant, type Room } from "@livekit/rtc-node";
import { waitForCallerReady } from "../src/services/callerAnswerService.js";

function fixture(status = "dialing") {
  const caller = {
    identity: "phone-customer",
    kind: ParticipantKind.SIP,
    attributes: { "sip.callStatus": status },
  } as unknown as RemoteParticipant;
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map([[caller.identity, caller]]),
  });
  return { caller, room, rtcRoom: room as unknown as Room };
}

test("outbound caller presence and ringing do not release recording/greeting before answer", async () => {
  const { caller, room, rtcRoom } = fixture();
  let released = false;
  const pending = waitForCallerReady(rtcRoom, caller.identity, true).then((value) => {
    released = true;
    return value;
  });
  room.emit(RoomEvent.ParticipantConnected, caller);
  await Promise.resolve();
  assert.equal(released, false);
  for (const status of ["ringing", "automation"]) {
    caller.attributes["sip.callStatus"] = status;
    room.emit(RoomEvent.ParticipantAttributesChanged, caller.attributes, caller);
    await Promise.resolve();
    assert.equal(released, false);
  }
  const unrelated = { ...caller, identity: "another-call", attributes: { "sip.callStatus": "active" } };
  room.emit(RoomEvent.ParticipantAttributesChanged, unrelated.attributes, unrelated);
  await Promise.resolve();
  assert.equal(released, false);
  caller.attributes["sip.callStatus"] = "active";
  room.emit(RoomEvent.ParticipantAttributesChanged, caller.attributes, caller);
  assert.equal(await pending, caller);
  assert.deepEqual(room.eventNames(), []);
});

test("unanswered timeout never returns the ringing participant", async () => {
  const { caller, room, rtcRoom } = fixture();
  assert.equal(await waitForCallerReady(rtcRoom, caller.identity, true, 5), null);
  assert.deepEqual(room.eventNames(), []);
});

for (const event of [RoomEvent.ParticipantDisconnected, RoomEvent.Disconnected]) {
  test(`unanswered ${event} cancels the wait and cleans listeners`, async () => {
    const { caller, room, rtcRoom } = fixture();
    const pending = waitForCallerReady(rtcRoom, caller.identity, true);
    room.emit(event, caller);
    assert.equal(await pending, null);
    assert.deepEqual(room.eventNames(), []);
  });
}

test("already answered callers proceed immediately and inbound/web callers still use presence", async () => {
  const { caller, rtcRoom } = fixture("active");
  assert.equal(await waitForCallerReady(rtcRoom, caller.identity, true), caller);
  caller.attributes["sip.callStatus"] = "ringing";
  assert.equal(await waitForCallerReady(rtcRoom, caller.identity), caller);
});
