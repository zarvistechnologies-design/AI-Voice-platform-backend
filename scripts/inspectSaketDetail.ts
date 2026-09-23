import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

async function main() {
  await connectDatabase();
  const saketAgent = await VoiceAgentModel.findById("6a951bbf35cda72c82172ec9");
  console.log("=== SAKET AGENT ===");
  console.log(JSON.stringify({
    id: saketAgent?._id,
    name: saketAgent?.name,
    ownerId: saketAgent?.ownerId,
    language: saketAgent?.language,
    multilingualEnabled: saketAgent?.multilingualEnabled,
    languageSwitchingEnabled: saketAgent?.languageSwitchingEnabled,
    supportedLanguages: saketAgent?.supportedLanguages,
    voice: saketAgent?.voice,
    llmProvider: saketAgent?.llmProvider,
    model: saketAgent?.model,
    ttsProvider: saketAgent?.ttsProvider,
    sttProvider: saketAgent?.sttProvider,
    widgetPublicKey: saketAgent?.widgetPublicKey,
    widgetShareKey: saketAgent?.widgetShareKey,
    isPublished: saketAgent?.isPublished,
    systemPromptLength: saketAgent?.prompt?.length,
    firstMessage: saketAgent?.firstMessage,
  }, null, 2));

  console.log("\n--- Prompt snippet ---");
  console.log(saketAgent?.prompt?.slice(0, 500));

  const websiteAgent = await VoiceAgentModel.findById("6a818ee880e87c6c405274b3");
  console.log("\n=== WEBSITE ASSISTANT AGENT ===");
  console.log(JSON.stringify({
    id: websiteAgent?._id,
    name: websiteAgent?.name,
    widgetPublicKey: websiteAgent?.widgetPublicKey,
    widgetShareKey: websiteAgent?.widgetShareKey,
    isPublished: websiteAgent?.isPublished,
  }, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
