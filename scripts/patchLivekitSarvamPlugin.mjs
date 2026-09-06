import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pluginPath = resolve(scriptDir, "../node_modules/@livekit/agents-plugin-sarvam/dist/tts.js");
const pluginPackagePath = resolve(
  scriptDir,
  "../node_modules/@livekit/agents-plugin-sarvam/package.json",
);
const pluginPackage = JSON.parse(await readFile(pluginPackagePath, "utf8"));

if (pluginPackage.version !== "1.5.0") {
  throw new Error(
    `Unsupported @livekit/agents-plugin-sarvam ${pluginPackage.version}; review the streaming buffer patch.`,
  );
}

const marker = "// ai-voice-sarvam-low-latency-buffer-v2";
let source = await readFile(pluginPath, "utf8");
if (source.includes(marker)) process.exit(0);

// v1 accidentally patched buildRequestBody(), where Sarvam ignores these
// WebSocket-only fields. Remove it when upgrading an existing installation so
// local development and a clean production install produce identical code.
source = source.replace(
  `    output_audio_codec: opts.outputAudioCodec,
    // ai-voice-sarvam-low-latency-buffer-v1
    min_buffer_size: Math.min(200, Math.max(10, Number(process.env.SARVAM_TTS_MIN_BUFFER_SIZE ?? 20) || 20)),
    max_chunk_length: Math.min(500, Math.max(50, Number(process.env.SARVAM_TTS_MAX_CHUNK_LENGTH ?? 120) || 120))`,
  "    output_audio_codec: opts.outputAudioCodec",
);

const existing = `function buildWsConfigMessage(opts) {
  const data = {
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    output_audio_codec: opts.outputAudioCodec
  };`;
const replacement = `function buildWsConfigMessage(opts) {
  const data = {
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    output_audio_codec: opts.outputAudioCodec,
    ${marker}
    min_buffer_size: Math.min(200, Math.max(30, Number(process.env.SARVAM_TTS_MIN_BUFFER_SIZE ?? 30) || 30)),
    max_chunk_length: Math.min(500, Math.max(50, Number(process.env.SARVAM_TTS_MAX_CHUNK_LENGTH ?? 120) || 120))
  };`;

if (!source.includes(existing)) {
  throw new Error("Unsupported Sarvam TTS plugin WebSocket layout; review the streaming buffer patch.");
}

await writeFile(pluginPath, source.replace(existing, replacement), "utf8");
