import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import {
  ChunkedStream,
  TTS,
} from "../node_modules/@livekit/agents-plugin-openai/dist/tts.js";

initializeLogger({ pretty: false, level: "silent" });

let responseFinished = false;
let finishResponse;
const responseBody = new ReadableStream({
  start(controller) {
    // Two 100 ms PCM frames are enough for the adapter to emit its first frame
    // while retaining the second one to mark finality correctly.
    controller.enqueue(new Uint8Array(9600));
    finishResponse = () => {
      responseFinished = true;
      controller.enqueue(new Uint8Array(4800));
      controller.close();
    };
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
  // Withhold the response tail until a frame is emitted. This proves genuine
  // streaming without a fragile timing assertion on a busy build machine.
  const timeout = setTimeout(() => {
    console.error("OpenAI TTS did not emit audio while the response was still open.");
    process.exit(1);
  }, 5000);
  const first = await stream.next();
  assert.equal(first.done, false, "OpenAI TTS did not emit an audio frame");
  assert.equal(
    responseFinished,
    false,
    "OpenAI TTS waited for the complete HTTP response before emitting audio",
  );
  finishResponse();
  for await (const unused of stream) void unused;
  clearTimeout(timeout);
  console.log("OpenAI TTS emitted audio before the HTTP response completed.");
} finally {
  await engine.close();
}
