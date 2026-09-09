import assert from "node:assert/strict";
import test from "node:test";

import { LowLatencySentenceTokenizer } from "../src/services/lowLatencyTtsService.js";

test("releases a complete first phrase without waiting for the next sentence", async () => {
  const stream = new LowLatencySentenceTokenizer().stream();
  stream.pushText("I can help you now.");

  const result = await stream.next();
  assert.equal(result.done, false);
  assert.equal(result.value?.token, "I can help you now.");
  stream.close();
});

test("retains partial text until terminal punctuation arrives", async () => {
  const stream = new LowLatencySentenceTokenizer().stream();
  let settled = false;
  const pending = stream.next().then((result) => {
    settled = true;
    return result;
  });

  stream.pushText("I can help you now");
  await Promise.resolve();
  assert.equal(settled, false);

  stream.pushText(".");
  const result = await pending;
  assert.equal(result.done, false);
  assert.equal(result.value?.token, "I can help you now.");
  stream.close();
});

test("supports terminal punctuation used by Indic and CJK replies", async () => {
  for (const phrase of ["मैं आपकी मदद कर सकता हूँ।", "私がお手伝いします。"]) {
    const stream = new LowLatencySentenceTokenizer().stream();
    stream.pushText(phrase);
    const result = await stream.next();
    assert.equal(result.done, false);
    assert.equal(result.value?.token, phrase);
    stream.close();
  }
});
