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

// Inworld's Realtime API intentionally follows OpenAI's GA realtime event
// schema, but uses a different WebSocket path, query, and Basic auth. Keep the
// upstream session/event implementation and only adapt those provider edges.
const realtimePatchMarker = "// ai-voice-inworld-realtime-patch-v1";
const realtimeTargets = [
  resolve(pluginDir, "dist/realtime/realtime_model.js"),
  resolve(pluginDir, "dist/realtime/realtime_model.cjs"),
];

for (const path of realtimeTargets) {
  let source = await readFile(path, "utf8");
  if (source.includes(realtimePatchMarker)) continue;

  const urlAnchor = '  const url = new URL([baseURL, realtimePath].join("/"));';
  const urlReplacement = [
    urlAnchor,
    `  ${realtimePatchMarker}`,
    '  if (url.hostname === "api.inworld.ai") {',
    '    url.protocol = "wss:";',
    '    url.pathname = "/api/v1/realtime/session";',
    '    url.search = "";',
    '    url.searchParams.set("key", "voice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));',
    '    url.searchParams.set("protocol", "realtime");',
    '    return url.toString();',
    '  }',
  ].join("\n");
  if (!source.includes(urlAnchor)) {
    throw new Error(`Unsupported OpenAI realtime URL patch state in ${path}.`);
  }
  source = source.replace(urlAnchor, urlReplacement);

  const optionsAnchor = '    const maxOutputTokens = opts.maxResponseOutputTokens === Infinity ? "inf" : opts.maxResponseOutputTokens;';
  const optionsReplacement = [
    optionsAnchor,
    '    const isInworldEndpoint = new URL(opts.baseURL).hostname === "api.inworld.ai";',
  ].join("\n");
  if (!source.includes(optionsAnchor)) {
    throw new Error(`Unsupported OpenAI realtime session patch state in ${path}.`);
  }
  source = source.replace(optionsAnchor, optionsReplacement);

  const outputAnchor = `          output: {
            format: audioFormat,
            speed: opts.speed,
            voice: opts.voice
          }`;
  const outputReplacement = `          output: {
            format: audioFormat,
            speed: opts.speed,
            voice: opts.voice,
            ...isInworldEndpoint ? { model: "inworld-tts-2" } : {}
          }`;
  if (!source.includes(outputAnchor)) {
    throw new Error(`Unsupported OpenAI realtime audio-output patch state in ${path}.`);
  }
  source = source.replace(outputAnchor, outputReplacement);

  const providerDataAnchor = `        instructions: this.instructions,
        ...includeReasoning ? { reasoning: opts.reasoning } : {}`;
  const providerDataReplacement = `        instructions: this.instructions,
        ...isInworldEndpoint ? { providerData: { auto_tool_response: false } } : {},
        ...includeReasoning ? { reasoning: opts.reasoning } : {}`;
  if (!source.includes(providerDataAnchor)) {
    throw new Error(`Unsupported OpenAI realtime provider-data patch state in ${path}.`);
  }
  source = source.replace(providerDataAnchor, providerDataReplacement);

  const authAnchor = '      headers.Authorization = `Bearer ${this._options.apiKey}`;';
  const authReplacement = [
    '      const inworldEndpoint = new URL(this._options.baseURL).hostname === "api.inworld.ai";',
    '      headers.Authorization = (inworldEndpoint ? "Basic " : "Bearer ") + this._options.apiKey;',
  ].join("\n");
  if (!source.includes(authAnchor)) {
    throw new Error(`Unsupported OpenAI realtime auth patch state in ${path}.`);
  }
  source = source.replace(authAnchor, authReplacement);

  await writeFile(path, source, "utf8");
}
