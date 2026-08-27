import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedLatencySamples,
  latencyPercentiles,
  latencySampleWindowSize,
} from "../src/services/latencyStatistics.js";

test("keeps a bounded recent latency window", () => {
  const samples = Array.from({ length: 150 }, (_, index) => index);
  const bounded = boundedLatencySamples(samples, 150);
  assert.equal(bounded.length, latencySampleWindowSize);
  assert.deepEqual(bounded.slice(0, 2), [51, 52]);
  assert.equal(bounded.at(-1), 150);
});

test("calculates tail latency with nearest-rank percentiles", () => {
  const summary = latencyPercentiles(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(summary, {
    minMs: 1,
    p50Ms: 50,
    p90Ms: 90,
    p95Ms: 95,
    p99Ms: 99,
    maxMs: 100,
  });
});
