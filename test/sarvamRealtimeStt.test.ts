import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  buildSarvamRealtimeSttUrl,
  probeSarvamRealtimeStt,
  SarvamRealtimeSTT,
  sarvamRealtimeLanguageCode,
} from "../src/services/sarvamRealtimeStt.js";

test("builds the lowest-latency Sarvam realtime STT connection", () => {
  const url = new URL(buildSarvamRealtimeSttUrl({
    apiKey: "test-key",
    languageCode: "unknown",
    prompt: "UPI and EMI",
    silenceDurationMs: 150,
    minSpeechDurationMs: 100,
  }));

  assert.equal(url.pathname, "/speech-to-text-realtime/ws");
  assert.equal(url.searchParams.get("model"), "saaras:v3-realtime");
  assert.equal(url.searchParams.get("language_code"), "auto");
  assert.equal(url.searchParams.get("stream_type"), "fast");
  assert.equal(url.searchParams.get("endpointing"), "vad");
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("silence_duration_ms"), "150");
  assert.equal(url.searchParams.get("min_speech_duration_ms"), "100");
  assert.equal(url.searchParams.get("prompt"), "UPI and EMI");
});

test("normalizes legacy and automatic Sarvam language codes", () => {
  assert.equal(sarvamRealtimeLanguageCode("unknown"), "auto");
  assert.equal(sarvamRealtimeLanguageCode("od-IN"), "or-IN");
  assert.equal(sarvamRealtimeLanguageCode("ta-IN"), "ta-IN");
});

test("advertises partial realtime transcripts to the pipeline", () => {
  const recognizer = new SarvamRealtimeSTT({
    apiKey: "test-key",
    languageCode: "en-IN",
  });
  assert.equal(recognizer.model, "saaras:v3-realtime");
  assert.equal(recognizer.capabilities.streaming, true);
  assert.equal(recognizer.capabilities.interimResults, true);
});

test("prewarm probe waits for a real Sarvam session before enabling transport", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address ? address.port : 0;

  server.once("connection", (socket, request) => {
    assert.equal(request.headers["api-subscription-key"], "probe-key");
    socket.send(JSON.stringify({ event: "session.begin", session_id: "session-1" }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { event?: string };
      if (message.event === "ping") socket.send(JSON.stringify({ event: "pong" }));
      if (message.event === "end") socket.close();
    });
  });

  try {
    assert.equal(await probeSarvamRealtimeStt({
      apiKey: "probe-key",
      languageCode: "auto",
      baseUrl: `ws://127.0.0.1:${port}/speech-to-text-realtime/ws`,
      connectionTimeoutMs: 1_000,
    }), true);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
