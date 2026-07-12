import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pluginPath = resolve(scriptDir, "../node_modules/@livekit/agents-plugin-google/dist/llm.js");
const source = await readFile(pluginPath, "utf8");

if (source.includes("let receivedOutput = false;")) {
  process.exit(0);
}

const responseMarker = "      for await (const chunk of response) {";
const metadataStart = "        if (!chunk.candidates || !((_e = (_d = chunk.candidates[0]) == null ? void 0 : _d.content) == null ? void 0 : _e.parts)) {";
const metadataEnd = "        if (chunk.candidates.length > 1) {";
const metadataReplacement = `        if (!chunk.candidates || !((_e = (_d = chunk.candidates[0]) == null ? void 0 : _d.content) == null ? void 0 : _e.parts)) {
          // Gemini can emit usage and other metadata before its content chunk.
          this.logger.debug(\`No content in the response chunk: \${JSON.stringify(chunk)}\`);
          continue;
        }`;
const outputMarker = "            chunksYielded = true;\n            retryable = false;";
const outputReplacement = "            chunksYielded = true;\n            receivedOutput = true;\n            retryable = false;";
const loopMarker = "      }\n    } catch (error) {";
const loopReplacement = `      }
      if (!receivedOutput) {
        throw new APIStatusError({
          message: "Google LLM: no usable content in the response",
          options: { retryable: true, requestId }
        });
      }
    } catch (error) {`;

const metadataStartIndex = source.indexOf(metadataStart);
const metadataEndIndex = source.indexOf(metadataEnd, metadataStartIndex);

if (!source.includes(responseMarker) || metadataStartIndex < 0 || metadataEndIndex < 0 || !source.includes(outputMarker) || !source.includes(loopMarker)) {
  throw new Error("Unsupported @livekit/agents-plugin-google version; review the Gemini stream patch.");
}

const withMetadataPatched = [
  source.slice(0, metadataStartIndex),
  metadataReplacement,
  source.slice(metadataEndIndex),
].join("\n");

await writeFile(
  pluginPath,
  withMetadataPatched
    .replace(responseMarker, `      let receivedOutput = false;\n${responseMarker}`)
    .replace(outputMarker, outputReplacement)
    .replace(loopMarker, loopReplacement),
  "utf8",
);
