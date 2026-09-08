import assert from "node:assert/strict";
import test from "node:test";
import { optionalVoiceContext, voiceJobRoomContext } from "../src/services/voiceStartup.js";

test("inbound routing uses dispatch room data before RTC connection resolves", () => {
  const context = voiceJobRoomContext({
    job: { room: { name: "inbound-123-caller", metadata: '{"agentId":"agent"}' } },
    room: { name: undefined, metadata: undefined },
  });
  assert.equal(context.roomName, "inbound-123-caller");
  assert.equal(context.metadata, '{"agentId":"agent"}');
});

test("dispatch metadata overrides stale room metadata and missing names fail", () => {
  assert.equal(voiceJobRoomContext({
    job: { metadata: "latest", room: { name: "web-call", metadata: "stale" } },
    room: {},
  }).metadata, "latest");
  assert.throws(() => voiceJobRoomContext({ job: {}, room: {} }), /missing its room name/);
});

test("optional history cannot hold startup while database pool waits indefinitely", async () => {
  const result = await optionalVoiceContext(new Promise<string>(() => {}), 15);
  assert.equal(result, undefined);
});

test("late optional history never changes the chosen startup context", async () => {
  let complete!: (value: string) => void;
  const history = new Promise<string>((resolve) => { complete = resolve; });
  const result = await optionalVoiceContext(history, 15);
  complete("late context");
  await history;
  assert.equal(result, undefined);
  assert.equal(await optionalVoiceContext(Promise.resolve("ready context"), 100), "ready context");
});

test("optional read failures remain observable", async () => {
  await assert.rejects(optionalVoiceContext(Promise.reject(new Error("offline")), 100), /offline/);
});
