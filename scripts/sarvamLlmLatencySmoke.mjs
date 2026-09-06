import "dotenv/config";

import OpenAI from "openai";

const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) throw new Error("No Sarvam API key is configured");

const model = process.env.SARVAM_LLM_SMOKE_MODEL || "sarvam-105b-conversations";
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.sarvam.ai/v1",
  timeout: 20_000,
  maxRetries: 0,
});

async function measure(effort) {
  const startedAt = Date.now();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "Reply in one short spoken sentence." },
      { role: "user", content: "Say नमस्ते." },
    ],
    max_tokens: effort ? 128 : 64,
    reasoning_effort: effort,
    stream: true,
  });
  let ttftMs = 0;
  let receivedText = false;
  for await (const chunk of response) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) {
      receivedText = true;
      if (!ttftMs) ttftMs = Date.now() - startedAt;
    }
  }
  if (!receivedText) throw new Error(`Sarvam ${effort ?? "direct"} request returned no text`);
  return ttftMs;
}

const directTtftMs = await measure(null);
const reasoningTtftMs = await measure("low");
console.log(JSON.stringify({
  event: "sarvam-llm-latency-smoke-passed",
  model,
  directTtftMs,
  reasoningTtftMs,
}));
