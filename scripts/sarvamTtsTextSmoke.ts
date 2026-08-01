import assert from "node:assert/strict";

import {
  normalizeSarvamTtsToken,
  SarvamSafeSentenceTokenizer,
} from "../src/services/sarvamTtsTextService.js";

assert.equal(normalizeSarvamTtsToken(" Hello there. "), "Hello there.");
assert.equal(
  normalizeSarvamTtsToken("\u0928\u092e\u0938\u094d\u0924\u0947"),
  "\u0928\u092e\u0938\u094d\u0924\u0947",
);
assert.equal(normalizeSarvamTtsToken("1234567890"), "Number 1234567890");
assert.equal(normalizeSarvamTtsToken("----------"), "");
assert.equal(normalizeSarvamTtsToken("*** \u{1f44b} ***"), "");

const skipped: string[] = [];
const tokenizer = new SarvamSafeSentenceTokenizer((text) => skipped.push(text));
assert.deepEqual(tokenizer.tokenize("Hello there. ----------"), ["Hello there."]);
assert.deepEqual(tokenizer.tokenize("1234567890"), ["Number 1234567890"]);

const stream = tokenizer.stream();
stream.pushText("Hello there. ----------");
stream.endInput();
stream.close();

const streamedTokens: string[] = [];
for await (const event of stream) streamedTokens.push(event.token);

assert.deepEqual(streamedTokens, ["Hello there."]);
assert.deepEqual(skipped, ["----------"]);

console.log("Sarvam TTS text smoke tests passed.");
