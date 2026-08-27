import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ttsPlugin = await readFile(
  resolve(scriptDir, "../node_modules/@livekit/agents-plugin-sarvam/dist/tts.js"),
  "utf8",
);

assert.match(ttsPlugin, /ai-voice-sarvam-low-latency-buffer-v1/);
assert.match(ttsPlugin, /min_buffer_size/);
assert.match(ttsPlugin, /max_chunk_length/);
console.log("Sarvam WebSocket low-latency buffer patch is active.");

