import assert from "node:assert/strict";
import test from "node:test";

import { llm } from "@livekit/agents";

import { SwitchableLlm } from "../src/services/switchableLlm.js";

class FakeLlm extends llm.LLM {
  readonly stream = { marker: this.modelName } as ReturnType<llm.LLM["chat"]>;
  closed = false;

  constructor(private readonly modelName: string) {
    super();
  }

  label() {
    return `fake.${this.modelName}`;
  }

  override get model() {
    return this.modelName;
  }

  override get provider() {
    return "fake";
  }

  override chat(_args: Parameters<llm.LLM["chat"]>[0]) {
    return this.stream;
  }

  override async aclose() {
    this.closed = true;
  }

  emitMetric(source: string) {
    this.emit("metrics_collected", { source } as never);
  }
}

test("switches delegates without losing old or new model metrics", async () => {
  const initial = new FakeLlm("initial");
  const cached = new FakeLlm("cached");
  const wrapper = new SwitchableLlm(initial);
  const metrics: unknown[] = [];
  wrapper.on("metrics_collected", (metric) => metrics.push(metric));

  assert.equal(wrapper.chat({} as never), initial.stream);
  assert.equal(wrapper.model, "initial");

  wrapper.activate(cached);
  assert.equal(wrapper.chat({} as never), cached.stream);
  assert.equal(wrapper.model, "cached");

  initial.emitMetric("in-flight-initial");
  cached.emitMetric("cached");
  assert.deepEqual(metrics, [
    { source: "in-flight-initial" },
    { source: "cached" },
  ]);

  await wrapper.aclose();
  assert.equal(initial.closed, true);
  assert.equal(cached.closed, true);
});
