import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// LiveKit 1.5.0 rejects generateReply() for Gemini 3.1 because it uses
// clientContent. Use realtimeInput.text while retaining LiveKit's pending
// generation, cancellation, timeout, and audio playback handling.
// https://ai.google.dev/gemini-api/docs/live-api/capabilities#sending-text
const pluginDir = new URL("../node_modules/@livekit/agents-plugin-google/", import.meta.url);
const pluginPackage = JSON.parse(await readFile(new URL("package.json", pluginDir), "utf8"));
if (pluginPackage.version !== "1.5.0") {
  throw new Error(`Unsupported @livekit/agents-plugin-google ${pluginPackage.version}; review the realtime greeting patch.`);
}

const marker = "// ai-voice-gemini-realtime-greeting-patch-v1";
const targets = ["dist/realtime/realtime_api.js", "dist/realtime/realtime_api.cjs"];
const updates = [];

for (const target of targets) {
  const path = new URL(target, pluginDir);
  const source = await readFile(path, "utf8");
  if (source.includes(marker)) continue;

  const methodStart = source.indexOf("  async generateReply(instructions, options = {}) {");
  const methodEnd = source.indexOf("\n  startUserActivity() {", methodStart);
  if (methodStart < 0 || methodEnd < 0) {
    throw new Error(`Unsupported Gemini realtime patch state in ${fileURLToPath(path)}.`);
  }
  let method = source.slice(methodStart, methodEnd);
  const guard = "    if (!this.realtimeModel.capabilities.midSessionChatCtxUpdate) {";
  const contentStart = method.indexOf("    const turns = [];");
  const contentEnd = method.indexOf("    const timeoutHandle = setTimeout(", contentStart);
  if (!method.includes(guard) || contentStart < 0 || contentEnd < 0) {
    throw new Error(`Unsupported Gemini generateReply implementation in ${fileURLToPath(path)}.`);
  }
  const legacyContent = method.slice(contentStart, contentEnd);
  const replacement = `    if (useRealtimeText) {
      this.sendClientEvent({
        type: "realtime_input",
        value: { text: instructions?.trim() || "Please respond now following your instructions." }
      });
    } else {
${legacyContent.trimEnd().split("\n").map((line) => `  ${line}`).join("\n")}
    }
`;
  method = method.replace(legacyContent, replacement).replace(
    guard,
    `    ${marker}
    const useRealtimeText = this.options.model.includes("gemini-3.1-");
    if (!this.realtimeModel.capabilities.midSessionChatCtxUpdate && !useRealtimeText) {`,
  );
  updates.push({ path, source: source.slice(0, methodStart) + method + source.slice(methodEnd) });
}

// Validate both module formats before writing either one.
for (const update of updates) await writeFile(update.path, update.source, "utf8");
