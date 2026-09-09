import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import {
  ChunkedStream,
  TTS,
} from "../node_modules/@livekit/agents-plugin-openai/dist/tts.js";

initializeLogger({ pretty: false, level: "silent" });

let responseFinished = false;
const responseBody = new ReadableStream({
  start(controller) {
    // Two 100 ms PCM frames are enough for the adapter to emit its first frame
    // while retaining the second one to mark finality correctly.
    controller.enqueue(new Uint8Array(9600));
    setTimeout(() => {
      responseFinished = true;
      controller.enqueue(new Uint8Array(4800));
      controller.close();
    }, 250);
  },
});

const engine = new TTS({
  apiKey: "streaming-smoke-test",
  model: "tts-1",
  voice: "alloy",
  speed: 1,
});

try {
  const stream = new ChunkedStream(
    engine,
    "streaming smoke test",
    Promise.resolve(new Response(responseBody)),
  );
  const first = await stream.next();
  assert.equal(first.done, false, "OpenAI TTS did not emit an audio frame");
  assert.equal(
    responseFinished,
    false,
    "OpenAI TTS waited for the complete HTTP response before emitting audio",
  );
  for await (const unused of stream) void unused;
  console.log("OpenAI TTS emitted audio before the HTTP response completed.");
} finally {
  await engine.close();
}
