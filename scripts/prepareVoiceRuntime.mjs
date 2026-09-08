import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Offline only: apply pinned SDK fixes even when an install skipped lifecycle
// scripts. Build, local worker startup and tests must use the same runtime.
for (const script of [
  "patchLivekitGooglePlugin.mjs",
  "patchLivekitOpenAIPlugin.mjs",
  "patchLivekitSarvamPlugin.mjs",
  "sarvamStreamingSmoke.mjs",
  "openAiTtsStreamingSmoke.mjs",
]) {
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: "inherit", timeout: 30_000,
  });
}

const geminiPlugin = readFileSync(new URL("../node_modules/@livekit/agents-plugin-google/dist/llm.js", import.meta.url), "utf8");
assert.match(geminiPlugin, /ai-voice-gemini-stream-patch-v2/);
console.log("Voice runtime streaming fixes applied and verified without provider calls.");
