import assert from "node:assert/strict";

import {
  decodeExotelPcm,
  encodeExotelPcm,
  exotelPhoneCandidates,
  exotelSampleRate,
  ExotelPcmChunker,
  parseExotelStreamEvent,
} from "../src/services/exotelProtocol.js";

const parsed = parseExotelStreamEvent(JSON.stringify({
  event: "start",
  stream_sid: "stream-test",
  start: {
    from: "+919876543210",
    to: "09876543210",
    media_format: { encoding: "audio/x-raw", sample_rate: "16000" },
  },
}));
assert.equal(parsed.event, "start");
if (parsed.event !== "start") throw new Error("Expected an Exotel start event.");
assert.equal(exotelSampleRate(parsed), 16_000);

const deployedFormat = parseExotelStreamEvent(JSON.stringify({
  event: "start",
  stream_sid: "stream-base64",
  start: {
    from: "07300655336",
    to: "08047362414",
    media_format: { encoding: "base64", sample_rate: "16000", bit_rate: "16" },
  },
}));
assert.equal(deployedFormat.event, "start");
if (deployedFormat.event !== "start") throw new Error("Expected an Exotel base64 start event.");
assert.equal(exotelSampleRate(deployedFormat), 16_000);
assert.ok(exotelPhoneCandidates("09876543210").includes("+919876543210"));

const original = Int16Array.from([-32_768, -1_024, 0, 1_024, 32_767]);
const roundTrip = decodeExotelPcm(encodeExotelPcm(original).toString("base64"));
assert.deepEqual([...roundTrip], [...original]);

const chunker = new ExotelPcmChunker(16_000);
assert.equal(chunker.chunkBytes, 3_200);
assert.equal(chunker.push(new Int16Array(800)).length, 0);
assert.equal(chunker.push(new Int16Array(800))[0]?.byteLength, 3_200);

// An 8 kHz Exotel stream necessarily needs 200 ms to reach the provider's
// 3,200-byte minimum. Keep the preferred 16 kHz path covered explicitly.
assert.equal(new ExotelPcmChunker(8_000).chunkBytes, 3_200);
assert.equal(new ExotelPcmChunker(24_000).chunkBytes, 4_800);

assert.throws(() => parseExotelStreamEvent('{"event":"unknown"}'), /Unsupported Exotel/);
assert.throws(
  () => exotelSampleRate({ event: "start", start: { media_format: { sample_rate: 44_100 } } }),
  /Unsupported Exotel sample rate/,
);

console.log("Exotel bridge protocol smoke test passed.");
