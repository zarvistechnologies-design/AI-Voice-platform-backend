import assert from "node:assert/strict";
import test from "node:test";
import { firstVoiceClauseBoundary } from "../src/services/voicePhraseBoundary.js";
import { LowLatencySentenceTokenizer } from "../src/services/lowLatencyTtsService.js";
import { SarvamSafeSentenceTokenizer } from "../src/services/sarvamTtsTextService.js";

test("Sarvam releases a substantial first clause before sentence completion", { timeout: 2000 }, async () => {
  const prefix = "I can explain the available options for your request, ";
  const stream = new SarvamSafeSentenceTokenizer().stream();
  stream.pushText(prefix);
  const first = await stream.next();
  assert.equal(first.value?.token, prefix.trim());
  stream.pushText("and then we can discuss what you prefer.");
  stream.endInput();
  const rest: string[] = [];
  for await (const item of stream) rest.push(item.token);
  assert.equal([first.value?.token, ...rest].join(" "), prefix + "and then we can discuss what you prefer.");
  stream.close();
});

test("Hindi clauses retain all words and punctuation", { timeout: 2000 }, async () => {
  const prefix = "मैं आपकी जरूरत के अनुसार उपलब्ध विकल्प समझा सकता हूँ, ";
  const stream = new SarvamSafeSentenceTokenizer().stream();
  stream.pushText(prefix);
  assert.equal((await stream.next()).value?.token, prefix.trim());
  stream.pushText("फिर आप अपना विकल्प चुन सकते हैं।");
  stream.endInput();
  const rest: string[] = [];
  for await (const item of stream) rest.push(item.token);
  assert.equal(rest.join(" "), "फिर आप अपना विकल्प चुन सकते हैं।");
  stream.close();
});

test("short phrases and numeric punctuation are not split", () => {
  for (const text of [
    "Yes, please continue", "Please call Dr. Sharma tomorrow", "The fee is 1,500.50 rupees",
    "Please remember that your reference number today is 123, 456, 789",
    "Please remember that your appointment time will be: 10:30 tomorrow",
    "For all the details please visit our official website https: //example.com",
  ]) assert.equal(firstVoiceClauseBoundary(text), undefined, text);
});

test("explicit full-sentence mode remains available", { timeout: 2000 }, async () => {
  const stream = new LowLatencySentenceTokenizer().stream();
  let emitted = false;
  const first = stream.next().then((item) => { emitted = true; return item; });
  stream.pushText("I can explain the available options for your request, ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted, false);
  stream.pushText("and help you decide.");
  assert.equal((await first).value?.token, "I can explain the available options for your request, and help you decide.");
  stream.close();
});

test("an earlier complete sentence takes priority over a later clause", async () => {
  const stream = new SarvamSafeSentenceTokenizer().stream();
  stream.pushText("I can help you. I can explain the available options for your request, and help you decide.");
  stream.endInput();
  assert.equal((await stream.next()).value?.token, "I can help you.");
  stream.close();
});

test("streamed token boundaries neither lose nor repeat Hindi and English text", async () => {
  const texts = [
    "I can explain the available options for your request, and then we can discuss what you prefer.",
    "मैं आपकी जरूरत के अनुसार उपलब्ध विकल्प समझा सकता हूँ, फिर आप अपना विकल्प चुन सकते हैं।",
    "Please remember that your reference number today is 123, 456, 789 and the fee is 1,500.50 rupees.",
    "Please speak with Dr. Sharma about your appointment.",
    "I can help you. I can explain the available options for your request; you can then decide.",
  ];
  for (const text of texts) {
    for (const chunkSize of [1, 2, 5, 11, text.length]) {
      const stream = new SarvamSafeSentenceTokenizer().stream();
      for (let index = 0; index < text.length; index += chunkSize) {
        stream.pushText(text.slice(index, index + chunkSize));
      }
      stream.endInput();
      const output: string[] = [];
      for await (const item of stream) output.push(item.token);
      assert.equal(output.join(" "), text, `chunk size ${chunkSize}: ${text}`);
      stream.close();
    }
  }
});
