import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pluginDir = resolve(scriptDir, "../node_modules/@livekit/agents-plugin-openai");
const pluginPackage = JSON.parse(await readFile(resolve(pluginDir, "package.json"), "utf8"));

if (pluginPackage.version !== "1.5.0") {
  throw new Error(
    `Unsupported @livekit/agents-plugin-openai ${pluginPackage.version}; review the TTS stream patch.`,
  );
}

const patchMarker = "// ai-voice-openai-tts-stream-patch-v1";
const targets = [
  {
    path: resolve(pluginDir, "dist/tts.js"),
    audioByteStream: "AudioByteStream",
    shortuuid: "shortuuid",
  },
  {
    path: resolve(pluginDir, "dist/tts.cjs"),
    audioByteStream: "import_agents.AudioByteStream",
    shortuuid: "(0, import_agents.shortuuid)",
  },
];

for (const target of targets) {
  const source = await readFile(target.path, "utf8");
  if (source.includes(patchMarker)) continue;

  const oldStart = "      const buffer = await this.stream.then((r) => r.arrayBuffer());";
  const oldEnd = "      sendLastFrame(requestId, true);";
  const startIndex = source.indexOf(oldStart);
  const endIndex = source.indexOf(oldEnd, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unsupported OpenAI TTS patch state in ${target.path}.`);
  }

  const replacement = `      ${patchMarker}
      const response = await this.stream;
      if (!response.body) {
        throw new Error("OpenAI TTS response did not include a streaming body");
      }
      const requestId = ${target.shortuuid}();
      const audioByteStream = new ${target.audioByteStream}(OPENAI_TTS_SAMPLE_RATE, OPENAI_TTS_CHANNELS);
      let lastFrame;
      const sendLastFrame = (segmentId, final) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = void 0;
        }
      };
      const emitFrames = (frames) => {
        for (const frame of frames) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      };
      // The upstream adapter awaited response.arrayBuffer(), which delayed
      // playback until the entire sentence was synthesized. PCM chunks can be
      // framed and emitted immediately as the HTTP response arrives.
      for await (const chunk of response.body) {
        emitFrames(audioByteStream.write(chunk));
      }
      emitFrames(audioByteStream.flush());
      sendLastFrame(requestId, true);`;

  const updatedSource = [
    source.slice(0, startIndex),
    replacement,
    source.slice(endIndex + oldEnd.length),
  ].join("");
  await writeFile(target.path, updatedSource, "utf8");
}
