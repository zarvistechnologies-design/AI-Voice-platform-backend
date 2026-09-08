import assert from "node:assert/strict";
import test from "node:test";
import { createCallDisconnect, runCallCleanup } from "../src/services/voiceShutdown.js";

test("slow reporting cannot postpone transport disconnection", async () => {
  let finishReport!: () => void;
  let disconnected = false;
  let completed = false;
  const reporting = new Promise<void>((resolve) => { finishReport = resolve; });
  const cleanup = runCallCleanup([
    () => reporting,
    async () => { disconnected = true; },
  ]).then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disconnected, true);
  assert.equal(completed, false, "reporting must still be retained, not abandoned");
  finishReport();
  await cleanup;
});

test("reporting failure cannot prevent hang-up and remains observable", async () => {
  let disconnected = false;
  await assert.rejects(runCallCleanup([
    () => { throw new Error("database unavailable"); },
    async () => { disconnected = true; },
  ]), AggregateError);
  assert.equal(disconnected, true);
});

test("transport failure does not skip final call reporting", async () => {
  let reported = false;
  await assert.rejects(runCallCleanup([
    async () => { throw new Error("LiveKit unavailable"); },
    async () => { reported = true; },
  ]), AggregateError);
  assert.equal(reported, true);
});

test("duplicate tool, session and cleanup requests share one disconnect", async () => {
  let requests = 0;
  const disconnect = createCallDisconnect(async () => { requests += 1; });
  await Promise.all([disconnect(), disconnect(), disconnect()]);
  await disconnect();
  assert.equal(requests, 1);
});

test("failed disconnect can be retried after reporting finishes", async () => {
  let requests = 0;
  const disconnect = createCallDisconnect(async () => {
    requests += 1;
    if (requests === 1) throw new Error("transient failure");
  });
  await assert.rejects(disconnect(), /transient failure/);
  await disconnect();
  assert.equal(requests, 2);
});
