import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ttsPlugin = await readFile(
  resolve(scriptDir, "../node_modules/@livekit/agents-plugin-sarvam/dist/tts.js"),
  "utf8",
);

const requestBody = ttsPlugin.slice(
  ttsPlugin.indexOf("function buildRequestBody"),
  ttsPlugin.indexOf("function buildWsConfigMessage"),
);
const websocketConfig = ttsPlugin.slice(
  ttsPlugin.indexOf("function buildWsConfigMessage"),
  ttsPlugin.indexOf("class TTS"),
);

assert.doesNotMatch(requestBody, /min_buffer_size/);
assert.match(websocketConfig, /ai-voice-sarvam-low-latency-buffer-v2/);
assert.match(websocketConfig, /min_buffer_size/);
assert.match(websocketConfig, /Math\.max\(30,/);
assert.match(websocketConfig, /max_chunk_length/);
assert.match(ttsPlugin, /ai-voice-sarvam-no-redundant-flush-v1/);
const closeBody = ttsPlugin.slice(
  ttsPlugin.indexOf("  async closeWebSocket(ws) {"),
  ttsPlugin.indexOf("  async run() {", ttsPlugin.indexOf("  async closeWebSocket(ws) {")),
);
assert.doesNotMatch(closeBody, /setTimeout|ws\.send\(/);
console.log("Sarvam WebSocket low-latency buffer patch is active.");
