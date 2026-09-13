import "dotenv/config";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const apiKey = process.env.INWORLD_API_KEY?.trim();
if (!apiKey) throw new Error("INWORLD_API_KEY is required");

const models = [
  "openai/gpt-4o-mini",
  "google-ai-studio/gemini-2.5-flash",
];
const url = new URL("wss://api.inworld.ai/api/v1/realtime/session");
url.searchParams.set("key", `voice-smoke-${randomUUID()}`);
url.searchParams.set("protocol", "realtime");

const socket = new WebSocket(url, {
  headers: { Authorization: `Basic ${apiKey}` },
});

let modelIndex = 0;
const timeout = setTimeout(() => {
  socket.terminate();
  process.exitCode = 1;
  console.error("Inworld realtime handshake timed out.");
}, 15_000);

function updateSession(model) {
  socket.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      model,
      instructions: "Handshake validation only. Do not generate a response.",
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "inworld/inworld-stt-1", language: "en" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          model: "inworld-tts-2-flash",
          voice: "Ashley",
          speed: 1,
        },
      },
    },
  }));
}

socket.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type === "session.created") {
    updateSession(models[modelIndex]);
    return;
  }
  if (event.type === "session.updated") {
    modelIndex += 1;
    if (modelIndex < models.length) {
      updateSession(models[modelIndex]);
      return;
    }
    clearTimeout(timeout);
    console.log("Inworld realtime accepted GPT, Gemini, STT, and TTS session configuration.");
    socket.close();
    return;
  }
  if (event.type === "error") {
    clearTimeout(timeout);
    process.exitCode = 1;
    console.error(`Inworld realtime rejected the session: ${JSON.stringify(event.error)}`);
    socket.close();
  }
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  process.exitCode = 1;
  console.error(error.message);
});
