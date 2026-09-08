import assert from "node:assert/strict";
import test from "node:test";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import {
  recordCallLatencyStages, voiceLatencyRevision, type CallLatencyStageSample,
} from "../src/services/latencyService.js";

test("call stage diagnostics use one bounded, room-specific write with a revision", async (t) => {
  const writes: Array<{ filter: unknown; update: any }> = [];
  t.mock.method(CallDetailRecordModel, "updateOne", async (filter: unknown, update: unknown) => {
    writes.push({ filter, update });
  });
  const measuredAt = new Date("2026-09-08T12:00:00Z");
  const samples: CallLatencyStageSample[] = Array.from({ length: 70 }, (_, index) => ({
    stage: "tts", latencyMs: index, measuredAt, speechId: `speech-${index}`,
    provider: "sarvam", model: "bulbul:v3",
  }));
  for (const latencyMs of [-1, NaN, Infinity, 60_001]) {
    samples.push({ stage: "llm", latencyMs, measuredAt });
  }
  await recordCallLatencyStages("test-room", samples);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].filter, { livekitRoomName: "test-room" });
  const saved = writes[0].update.$set;
  assert.equal(saved.voiceLatencyRevision, voiceLatencyRevision);
  assert.equal(saved.latencyStageSamples.length, 64);
  assert.deepEqual(saved.latencyStageSamples[0], samples[6]);
  assert.deepEqual(saved.latencyStageSamples.at(-1), samples[69]);
  assert.equal(samples.length, 74, "the caller's samples are not mutated");
});

test("diagnostics preserve end-of-turn substage timings and remain hidden from default queries", async (t) => {
  let saved: any;
  t.mock.method(CallDetailRecordModel, "updateOne", async (_filter: unknown, update: any) => {
    saved = update.$set;
  });
  const sample: CallLatencyStageSample = {
    stage: "end_of_utterance", latencyMs: 450, measuredAt: new Date(),
    speechId: "speech-1", transcriptionDelayMs: 300, onUserTurnCompletedDelayMs: 40,
  };
  await recordCallLatencyStages("test-room", [sample]);
  const record = new CallDetailRecordModel(saved);
  assert.equal(record.latencyStageSamples[0].transcriptionDelayMs, 300);
  assert.equal(record.latencyStageSamples[0].onUserTurnCompletedDelayMs, 40);
  assert.equal(CallDetailRecordModel.schema.path("latencyStageSamples").options.select, false);
  assert.equal(CallDetailRecordModel.schema.path("voiceLatencyRevision").options.select, false);
});

test("an empty room name cannot write stage diagnostics", async (t) => {
  const update = t.mock.method(CallDetailRecordModel, "updateOne", async () => {
    assert.fail("unexpected database write");
  });
  await recordCallLatencyStages(" ", []);
  assert.equal(update.mock.callCount(), 0);
});
