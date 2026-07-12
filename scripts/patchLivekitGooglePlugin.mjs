import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pluginPath = resolve(scriptDir, "../node_modules/@livekit/agents-plugin-google/dist/llm.js");
const pluginPackagePath = resolve(scriptDir, "../node_modules/@livekit/agents-plugin-google/package.json");
const pluginPackage = JSON.parse(await readFile(pluginPackagePath, "utf8"));

if (pluginPackage.version !== "1.5.0") {
  throw new Error(
    `Unsupported @livekit/agents-plugin-google ${pluginPackage.version}; review the Gemini stream patch.`,
  );
}

const source = await readFile(pluginPath, "utf8");
const patchMarker = "// ai-voice-gemini-stream-patch-v2";
if (source.includes(patchMarker)) process.exit(0);

const responseMarker = "      for await (const chunk of response) {";
const metadataStart = "        if (!chunk.candidates || !((_e = (_d = chunk.candidates[0]) == null ? void 0 : _d.content) == null ? void 0 : _e.parts)) {";
const metadataEnd = "        if (chunk.candidates.length > 1) {";
const legacyMetadataReplacement = `        if (!chunk.candidates || !((_e = (_d = chunk.candidates[0]) == null ? void 0 : _d.content) == null ? void 0 : _e.parts)) {
          // Gemini can emit usage and other metadata before its content chunk.
          this.logger.debug(\`No content in the response chunk: \${JSON.stringify(chunk)}\`);
          continue;
        }`;
const metadataReplacement = `        if (!chunk.candidates || !((_e = (_d = chunk.candidates[0]) == null ? void 0 : _d.content) == null ? void 0 : _e.parts)) {
          // Gemini can emit usage and other metadata before its content chunk.
          this.logger.debug(\`No content in the response chunk: \${JSON.stringify(chunk)}\`);
          if (chunk.usageMetadata) {
            const usage = chunk.usageMetadata;
            this.queue.put({
              id: requestId,
              usage: {
                completionTokens: usage.candidatesTokenCount || 0,
                promptTokens: usage.promptTokenCount || 0,
                promptCachedTokens: usage.cachedContentTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
              }
            });
          }
          continue;
        }`;
const outputMarker = "            chunksYielded = true;\n            retryable = false;";
const outputReplacement = "            chunksYielded = true;\n            receivedOutput = true;\n            retryable = false;";
const loopMarker = "      }\n    } catch (error) {";
const loopReplacement = `      }
      if (!receivedOutput) {
        throw new APIStatusError({
          message: "Google LLM: no usable content in the response",
          options: { body: { reason: "no_usable_content" }, retryable: true, requestId }
        });
      }
    } catch (error) {`;
const existingEmptyResponseError = `          message: "Google LLM: no usable content in the response",
          options: { retryable: true, requestId }`;
const diagnosticEmptyResponseError = `          message: "Google LLM: no usable content in the response",
          options: { body: { reason: "no_usable_content" }, retryable: true, requestId }`;
const existingNoResponseError = `            message: "Google LLM: no response generated",
            options: {
              retryable,
              requestId
            }`;
const diagnosticNoResponseError = `            message: "Google LLM: no response generated",
            options: {
              body: { reason: "no_usable_content", finishReason: finishReason || "unknown" },
              retryable,
              requestId
            }`;

function replaceRequired(input, existing, replacement, label) {
  if (input.includes(replacement)) return input;
  if (!input.includes(existing)) {
    throw new Error(`Unsupported Gemini stream patch state; review ${label}.`);
  }
  return input.replace(existing, replacement);
}

let updatedSource = source;
if (!updatedSource.includes("let receivedOutput = false;")) {
  const metadataStartIndex = updatedSource.indexOf(metadataStart);
  const metadataEndIndex = updatedSource.indexOf(metadataEnd, metadataStartIndex);
  if (
    !updatedSource.includes(responseMarker) || metadataStartIndex < 0 || metadataEndIndex < 0 ||
    !updatedSource.includes(outputMarker) || !updatedSource.includes(loopMarker)
  ) {
    throw new Error("Unsupported @livekit/agents-plugin-google version; review the Gemini stream patch.");
  }
  updatedSource = [
    updatedSource.slice(0, metadataStartIndex),
    metadataReplacement,
    updatedSource.slice(metadataEndIndex),
  ].join("\n");
  updatedSource = updatedSource
    .replace(responseMarker, `      let receivedOutput = false;\n${responseMarker}`)
    .replace(outputMarker, outputReplacement)
    .replace(loopMarker, loopReplacement);
} else {
  updatedSource = replaceRequired(
    updatedSource, legacyMetadataReplacement, metadataReplacement, "usage-metadata handling",
  );
  updatedSource = replaceRequired(
    updatedSource, existingEmptyResponseError, diagnosticEmptyResponseError, "empty-response diagnostics",
  );
}

updatedSource = replaceRequired(
  updatedSource, existingNoResponseError, diagnosticNoResponseError, "no-response diagnostics",
);
updatedSource = updatedSource.replace(
  "      let receivedOutput = false;",
  `      ${patchMarker}\n      let receivedOutput = false;`,
);
await writeFile(pluginPath, updatedSource, "utf8");
