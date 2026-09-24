import { connectDatabase } from "../config/database.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";

async function run() {
  await connectDatabase();
  const agent = await VoiceAgentModel.findOne({ name: "dont touch it" }).lean();
  console.log("AGENT_VOICE_INFO:", {
    name: agent?.name,
    voice: agent?.voice,
    language: agent?.language,
    realtimeProvider: agent?.realtimeProvider,
    realtimeModel: agent?.realtimeModel,
    firstMessage: agent?.firstMessage,
  });
  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
