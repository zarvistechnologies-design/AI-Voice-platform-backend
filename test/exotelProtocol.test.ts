import assert from "node:assert/strict";
import test from "node:test";

import {
  EXOTEL_CLEAR_PLAYBACK_MESSAGE,
  EXOTEL_PLAYBACK_CONTROL_TOPIC,
  isExotelClearPlaybackMessage,
  ExotelPcmChunker,
  decodeExotelPcm,
} from "../src/services/exotelProtocol.js";

test("accepts only the explicit agent playback-clear signal", () => {
  assert.equal(
    isExotelClearPlaybackMessage(
      Buffer.from(EXOTEL_CLEAR_PLAYBACK_MESSAGE),
      EXOTEL_PLAYBACK_CONTROL_TOPIC,
    ),
    true,
  );
  assert.equal(
    isExotelClearPlaybackMessage(Buffer.from("clear"), "unrelated-topic"),
    false,
  );
  assert.equal(
    isExotelClearPlaybackMessage(Buffer.from("pause"), EXOTEL_PLAYBACK_CONTROL_TOPIC),
    false,
  );
});

test("audio packetization preserves every sample including a partial final packet", () => {
  for (const sampleRate of [8_000, 16_000, 24_000]) {
    const chunker = new ExotelPcmChunker(sampleRate);
    const input = Int16Array.from({ length: sampleRate / 5 + 123 }, (_, i) => (i % 60_000) - 30_000);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < input.length; offset += 317) {
      chunks.push(...chunker.push(input.slice(offset, offset + 317)));
    }
    const tail = chunker.flush();
    assert.ok(tail);
    chunks.push(tail);
    for (const chunk of chunks) {
      assert.ok(chunk.byteLength >= 3_200);
      assert.equal(chunk.byteLength % 320, 0);
    }
    const output = decodeExotelPcm(Buffer.concat(chunks).toString("base64"));
    assert.deepEqual(output.slice(0, input.length), input);
    assert.ok(output.slice(input.length).every((sample) => sample === 0));
    assert.equal(chunker.flush(), undefined);
  }
});

test("interruption clears the pending tail so cancelled speech cannot replay", () => {
  const chunker = new ExotelPcmChunker(16_000);
  chunker.push(new Int16Array(400).fill(123));
  chunker.clear();
  assert.equal(chunker.flush(), undefined);
  chunker.push(new Int16Array(200).fill(456));
  const next = decodeExotelPcm(chunker.flush()!.toString("base64"));
  assert.ok(next.slice(0, 200).every((sample) => sample === 456));
  assert.ok(next.slice(200).every((sample) => sample === 0));
});
