import assert from "node:assert/strict";
import test from "node:test";
import { initializeLogger, tts } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as google from "@livekit/agents-plugin-google";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import {
  createLowLatencySentenceTokenizer, LowLatencyTtsStreamAdapter,
} from "../src/services/lowLatencyTtsService.js";

initializeLogger({ pretty: false, level: "silent" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const prefix = "I can explain the available options for your request, ";
const continuation = "and I can also explain how the service fits your needs, ";

function inputStream() {
  let controller!: ReadableStreamDefaultController<string>;
  const source = new ReadableStream<string>({ start(value) { controller = value; } });
  return { source, push: (text: string) => controller.enqueue(text), end: () => controller.close() };
}

for (const provider of ["openai", "gemini"] as const) {
  test(`${provider} HTTP voice starts before LLM completion, streams audio and preserves its tail`, { timeout: 5000 }, async (t) => {
    const requests: string[] = [];
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
    const firstPcm = new Uint8Array(9600);
    const lastPcm = new Uint8Array(480); // Partial final frame must not be lost.
    let engine: tts.TTS;
    if (provider === "openai") {
      engine = new openai.TTS({
        model: "gpt-4o-mini-tts", voice: "alloy",
        client: {
          baseURL: "https://api.openai.com/v1",
          audio: { speech: { create: async (body: { input: string }) => {
            requests.push(body.input);
            return new Response(new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(firstPcm);
                await tail;
                controller.enqueue(lastPcm);
                controller.close();
              },
            }));
          } } },
        } as any,
      });
    } else {
      const gemini = new google.beta.TTS({ apiKey: "offline-test", model: "gemini-3.1-flash-tts-preview", voiceName: "Kore" });
      const chunk = (pcm: Uint8Array) => ({ candidates: [{ content: { parts: [{
        inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(pcm).toString("base64") },
      }] } }] });
      t.mock.method(gemini.client.models, "generateContentStream", async function* (request: any) {
        requests.push(request.contents[0].parts[0].text.match(/"([\s\S]*)"$/)[1]);
        yield chunk(firstPcm);
        await tail;
        yield chunk(lastPcm);
      });
      engine = gemini;
    }

    const adapter = new LowLatencyTtsStreamAdapter(engine);
    adapter.on("error", (event) => assert.fail(event.error.message));
    const stream = adapter.stream();
    const input = inputStream();
    stream.updateInputStream(input.source);
    try {
      input.push(prefix);
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.notEqual(first.value, tts.SynthesizeStream.END_OF_STREAM);
      assert.deepEqual(requests, [prefix.trim()], "provider starts before the rest of the LLM text arrives");
      let sampleCount = (first.value as tts.SynthesizedAudio).frame.samplesPerChannel;
      input.push(continuation);
      await tick();
      assert.equal(requests.length, 1, "later clauses do not cause repeated small HTTP requests");
      releaseTail();
      input.push("then you can decide.");
      input.end();
      for await (const audio of stream) {
        if (audio !== tts.SynthesizeStream.END_OF_STREAM) sampleCount += audio.frame.samplesPerChannel;
      }
      assert.deepEqual(requests, [prefix.trim(), continuation + "then you can decide."]);
      assert.equal(sampleCount, 2 * (firstPcm.length + lastPcm.length) / 2, "all PCM samples reach output in both requests");
    } finally {
      releaseTail();
      stream.close();
      await adapter.close();
    }
  });
}

test("ElevenLabs sends the first clause over its existing streaming connection", { timeout: 5000 }, async (t) => {
  const requests: string[] = [];
  let connectedStream: any;
  let done!: () => void;
  const connection = {
    registerStream(stream: unknown, waiter: { resolve: () => void }) { connectedStream = stream; done = waiter.resolve; },
    sendContent({ text }: { text: string }) {
      if (!text.trim()) return;
      requests.push(text.trim());
      connectedStream.pushAudio(new Uint8Array(9600));
    },
    closeContext() { connectedStream.markDone(); done(); },
  };
  const engine = new elevenlabs.TTS({
    apiKey: "offline-test", model: "eleven_flash_v2_5", voiceId: "unchanged-voice",
    autoMode: true, wordTokenizer: createLowLatencySentenceTokenizer(),
  });
  t.mock.method(engine, "currentConnection", async () => connection);
  engine.on("error", (event) => assert.fail(event.error.message));
  const stream = engine.stream();
  const input = inputStream();
  stream.updateInputStream(input.source);
  try {
    input.push(prefix);
    assert.equal((await stream.next()).done, false);
    assert.deepEqual(requests, [prefix.trim()]);
    input.push(continuation);
    await tick();
    assert.equal(requests.length, 1);
    input.push("then you can decide.");
    input.end();
    for await (const audio of stream) void audio;
    assert.deepEqual(requests, [prefix.trim(), continuation + "then you can decide."]);
    assert.equal(engine.model, "eleven_flash_v2_5");
  } finally {
    stream.close();
    await engine.close();
  }
});

test("closing the HTTP adapter closes its provider exactly once and preserves model metadata", async (t) => {
  const engine = new openai.TTS({ apiKey: "offline-test", model: "tts-1-hd", voice: "alloy" });
  const close = t.mock.method(engine, "close", async () => {});
  const adapter = new LowLatencyTtsStreamAdapter(engine);
  assert.equal(adapter.model, "tts-1-hd");
  assert.equal(adapter.provider, engine.provider);
  assert.equal(engine.listenerCount("metrics_collected"), 1);
  const first = adapter.close();
  assert.equal(adapter.close(), first);
  await first;
  assert.equal(close.mock.callCount(), 1);
  assert.equal(engine.listenerCount("metrics_collected"), 0);
  assert.equal(engine.listenerCount("error"), 0);
});

test("first-phrase mode resets for each reply and keeps later clauses intact in Hindi", async () => {
  const tokenizer = createLowLatencySentenceTokenizer();
  const first = "मैं आपकी जरूरत के अनुसार उपलब्ध विकल्प समझा सकता हूँ, ";
  const rest = "फिर मैं आपको सारी जानकारी विस्तार से बता सकता हूँ, उसके बाद आप चुन सकते हैं।";
  for (let turn = 0; turn < 2; turn += 1) {
    const stream = tokenizer.stream();
    stream.pushText(first);
    assert.equal((await stream.next()).value?.token, first.trim());
    stream.pushText(rest);
    stream.endInput();
    const output: string[] = [];
    for await (const item of stream) output.push(item.token);
    assert.equal(output.join(" "), rest);
    stream.close();
  }
});
