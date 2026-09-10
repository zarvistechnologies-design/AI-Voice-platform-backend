import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import "../scripts/patchLivekitGoogleRealtimePlugin.mjs";

const esm = await import("../node_modules/@livekit/agents-plugin-google/dist/realtime/realtime_api.js");
const cjs = createRequire(import.meta.url)("../node_modules/@livekit/agents-plugin-google/dist/realtime/realtime_api.cjs");

for (const [format, { RealtimeSession }] of [["ESM", esm], ["CommonJS", cjs]] as const) {
  // Exercise the installed adapter without opening a paid/network session.
  // Only transport and interruption are stubbed; generation tracking is real.
  function fixture(model: string) {
    const session = Object.create(RealtimeSession.prototype);
    const events: Array<{ type: string; value: Record<string, unknown> }> = [];
    const emitted: string[] = [];
    let interrupted = false;
    session.options = { model };
    session._realtimeModel = {
      capabilities: { midSessionChatCtxUpdate: !model.includes("3.1"), audioOutput: true },
    };
    session.sendClientEvent = (event: typeof events[number]) => events.push(event);
    session.emit = (name: string) => emitted.push(name);
    session.interrupt = async () => { interrupted = true; };
    return { session, events, emitted, interrupted: () => interrupted };
  }

  test(`${format}: Gemini 3.1 greets without caller audio and tracks the generated reply`, async () => {
    const { session, events, emitted } = fixture("gemini-3.1-flash-live-preview");
    const opening = "Say only: Hello, how can I help today?";
    const pending = session.generateReply(opening);
    assert.deepEqual(events, [{ type: "realtime_input", value: { text: opening } }]);
    assert.equal(session.realtimeModel.capabilities.midSessionChatCtxUpdate, false);
    session.startNewGeneration();
    const generation = await pending;
    assert.equal(generation.userInitiated, true);
    assert.ok(generation.messageStream);
    assert.deepEqual(emitted, ["generation_created"]);
    assert.equal(session.pendingGenerationFut, undefined);
  });

  test(`${format}: Gemini 2.5 retains the existing greeting protocol`, async () => {
    const { session, events } = fixture("gemini-2.5-flash-native-audio-preview-12-2025");
    const pending = session.generateReply("Greet the caller.");
    assert.deepEqual(events, [{
      type: "content",
      value: {
        turns: [
          { parts: [{ text: "Greet the caller." }], role: "model" },
          { parts: [{ text: "." }], role: "user" },
        ],
        turnComplete: true,
      },
    }]);
    session.startNewGeneration();
    await pending;
  });

  test(`${format}: cancelled Gemini 3.1 greeting clears the pending response`, async () => {
    const { session, interrupted } = fixture("gemini-3.1-flash-live-preview");
    const controller = new AbortController();
    const pending = session.generateReply("Greet the caller.", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /generateReply aborted/);
    assert.equal(session.pendingGenerationFut, undefined);
    assert.equal(interrupted(), true);
  });

  test(`${format}: Gemini 3.1 greeting still times out if the provider never responds`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { session } = fixture("gemini-3.1-flash-live-preview");
    const pending = session.generateReply("Greet the caller.");
    t.mock.timers.tick(5000);
    await assert.rejects(pending, /timed out waiting for generation_created/);
    assert.equal(session.pendingGenerationFut, undefined);
  });
}
