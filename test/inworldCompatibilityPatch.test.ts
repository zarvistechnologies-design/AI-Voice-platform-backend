import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const openAiPluginRoot = new URL(
  "../node_modules/@livekit/agents-plugin-openai/",
  import.meta.url,
);

async function pluginSource(path: string) {
  return readFile(new URL(path, openAiPluginRoot), "utf8");
}

for (const moduleFormat of ["js", "cjs"] as const) {
  test(`keeps Inworld realtime compatibility in the OpenAI ${moduleFormat} adapter`, async () => {
    const source = await pluginSource(`dist/realtime/realtime_model.${moduleFormat}`);
    assert.match(source, /ai-voice-inworld-realtime-patch-v1/);
    assert.match(source, /\/api\/v1\/realtime\/session/);
    assert.match(source, /protocol["']?,\s*["']realtime/);
    assert.match(source, /inworldEndpoint \? ["']Basic /);
    assert.match(source, /providerData:\s*\{ auto_tool_response: false \}/);
    assert.match(source, /model:\s*["']inworld-tts-2["']/);
  });

  test(`keeps Inworld Basic auth in the pipeline LLM ${moduleFormat} adapter`, async () => {
    const source = await pluginSource(`dist/llm.${moduleFormat}`);
    assert.match(source, /ai-voice-inworld-llm-basic-auth-patch-v1/);
    assert.match(source, /defaultHeaders:\s*\{ Authorization: ["']Basic ["'] \+/);
  });
}
