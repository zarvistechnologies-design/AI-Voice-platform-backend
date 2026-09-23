import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

async function main() {
  await connectDatabase();
  const agent = await VoiceAgentModel.findById("6a818ee880e87c6c405274b3");
  console.log("=== VOZON WEBSITE ASSISTANT ===");
  console.log(JSON.stringify({
    id: agent?._id,
    name: agent?.name,
    ownerId: agent?.ownerId,
    language: agent?.language,
    multilingualEnabled: agent?.multilingualEnabled,
    languageSwitchingEnabled: agent?.languageSwitchingEnabled,
    supportedLanguages: agent?.supportedLanguages,
    voice: agent?.voice,
    llmProvider: agent?.llmProvider,
    model: agent?.model,
    ttsProvider: agent?.ttsProvider,
    sttProvider: agent?.sttProvider,
    widget: agent?.widget,
    firstMessage: agent?.firstMessage,
    prompt: agent?.prompt,
  }, null, 2));

  process.exit(0);
}

main().catch(console.error);
