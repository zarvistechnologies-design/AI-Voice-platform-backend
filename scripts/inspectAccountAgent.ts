import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

async function main() {
  await connectDatabase();
  console.log("Connected to DB successfully.");

  const users = await UserModel.find({
    $or: [
      { email: { $regex: /sumit/i } },
      { name: { $regex: /sumit/i } }
    ]
  });
  console.log("=== MATCHED USERS ===");
  for (const u of users) {
    console.log({ id: u._id.toString(), email: u.email, name: u.name });
  }

  const user = users[0];
  console.log("User found:", user._id.toString(), user.email);

  const agentsByOwner = await VoiceAgentModel.find({
    $or: [
      { ownerId: user._id.toString() },
      { ownerId: user._id }
    ]
  });
  console.log("=== ALL AGENTS FOR USER ===");
  for (const a of agentsByOwner) {
    console.log("------------------------------------------");
    console.log({
      id: a._id.toString(),
      name: a.name,
      team: a.team,
      status: a.status,
      language: a.language,
      multilingualEnabled: (a as any).multilingualEnabled,
      languageSwitchingEnabled: (a as any).languageSwitchingEnabled,
      supportedLanguages: (a as any).supportedLanguages,
      voice: a.voice,
      llmProvider: a.llmProvider,
      model: (a as any).model,
      ttsProvider: a.ttsProvider,
      sttProvider: a.sttProvider,
      widgetShareKey: (a as any).widgetShareKey,
      widgetPublicKey: (a as any).widgetPublicKey,
      isPublished: (a as any).isPublished,
      firstMessage: (a as any).firstMessage,
    });
  }

  // Also let's check any agent with "sanet" or similar across whole DB
  const sanetAgents = await VoiceAgentModel.find({
    name: { $regex: /sanet|sanket|shant|sonet|senet|sumit/i }
  });
  console.log("=== AGENTS MATCHING SANET ANYWHERE ===");
  for (const a of sanetAgents) {
    console.log({
      id: a._id.toString(),
      name: a.name,
      ownerId: a.ownerId,
      language: a.language,
      multilingualEnabled: (a as any).multilingualEnabled,
      supportedLanguages: (a as any).supportedLanguages,
      promptSnippet: (a.prompt || "").slice(0, 100),
    });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error inspecting DB:", err);
  process.exit(1);
});
