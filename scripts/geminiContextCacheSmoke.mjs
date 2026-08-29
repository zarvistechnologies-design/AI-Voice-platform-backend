import "dotenv/config";

import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("No Google API key is configured");

const ai = new GoogleGenAI({ apiKey });
const model = process.env.GEMINI_CONTEXT_CACHE_SMOKE_MODEL || "gemini-2.5-flash";
let cacheName = "";

try {
  const cacheStartedAt = Date.now();
  const cache = await ai.caches.create({
    model,
    config: {
      displayName: `voice-context-cache-smoke-${Date.now()}`,
      systemInstruction: [
        "Reference policy: this is test data only. ".repeat(1_000),
        "Reply exactly OK and do not call a tool unless explicitly asked.",
      ].join("\n"),
      tools: [{
        functionDeclarations: [{
          name: "check_slot",
          description: "Smoke-test tool that must only run when explicitly requested.",
          parametersJsonSchema: {
            type: "object",
            properties: { date: { type: "string" } },
            required: ["date"],
          },
        }],
      }],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
      },
      ttl: "60s",
    },
  });
  const cacheCreateMs = Date.now() - cacheStartedAt;
  cacheName = cache.name ?? "";
  if (!cacheName) throw new Error("Gemini context-cache creation returned no name");

  const requestStartedAt = Date.now();
  const response = await ai.models.generateContentStream({
    model,
    contents: "Say OK.",
    config: {
      cachedContent: cacheName,
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 8,
    },
  });
  let cachedTtftMs = 0;
  let cachedTokens = 0;
  let receivedText = false;
  for await (const chunk of response) {
    if (chunk.text) {
      receivedText = true;
      if (!cachedTtftMs) cachedTtftMs = Date.now() - requestStartedAt;
    }
    cachedTokens = Math.max(
      cachedTokens,
      chunk.usageMetadata?.cachedContentTokenCount ?? 0,
    );
  }
  if (!receivedText) throw new Error("Gemini cached request returned no text");
  if (cachedTokens < 1) throw new Error("Gemini request did not report cached input tokens");
  console.log(JSON.stringify({
    event: "gemini-context-cache-smoke-passed",
    model,
    cacheCreateMs,
    cachedTtftMs,
    cachedTokens,
  }));
} finally {
  if (cacheName) await ai.caches.delete({ name: cacheName });
}
