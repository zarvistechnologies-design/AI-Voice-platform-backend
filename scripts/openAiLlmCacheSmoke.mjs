import "dotenv/config";

import { initializeLogger, llm } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";

initializeLogger({ pretty: false, level: "silent" });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("No OpenAI API key is configured");

const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
if (new URL(baseURL).hostname.toLowerCase() !== "api.openai.com") {
  console.log(JSON.stringify({
    event: "openai-llm-cache-smoke-skipped",
    reason: "non-official-endpoint",
  }));
  process.exit(0);
}

const model = process.env.OPENAI_VOICE_CACHE_SMOKE_MODEL || "gpt-5.6-luna";
const promptCacheKey = `voice-cache-smoke-${Date.now()}`;
const chatCtx = new llm.ChatContext();
chatCtx.addMessage({
  role: "system",
  content: [
    "Reference policy: this is test data only. ".repeat(1_000),
    "Reply exactly OK.",
  ].join("\n"),
});
chatCtx.addMessage({ role: "user", content: "Say OK." });

const modelClient = new openai.responses.LLM({
  apiKey,
  baseURL,
  model,
  maxOutputTokens: 64,
  reasoning: { effort: "none", context: "current_turn" },
  store: false,
  useWebSocket: true,
});
let modelError;
modelClient.on("error", (event) => {
  modelError = event.error;
});

async function runRequest() {
  const startedAt = Date.now();
  let ttftMs = 0;
  let cachedTokens = 0;
  let receivedText = false;
  const stream = modelClient.chat({
    chatCtx,
    extraKwargs: { prompt_cache_key: promptCacheKey },
  });
  for await (const chunk of stream) {
    if (chunk.delta?.content) {
      receivedText = true;
      if (!ttftMs) ttftMs = Date.now() - startedAt;
    }
    cachedTokens = Math.max(cachedTokens, chunk.usage?.promptCachedTokens ?? 0);
  }
  if (!receivedText) {
    throw modelError ?? new Error("OpenAI cached-stream request returned no text");
  }
  return { ttftMs, cachedTokens };
}

try {
  await runRequest();
  const cached = await runRequest();
  if (cached.cachedTokens < 1) {
    throw new Error("OpenAI request did not report cached input tokens");
  }
  console.log(JSON.stringify({
    event: "openai-llm-cache-smoke-passed",
    model,
    cachedTtftMs: cached.ttftMs,
    cachedTokens: cached.cachedTokens,
  }));
} finally {
  await modelClient.aclose();
}
