import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../dist/config/database.js";
import { VoiceAgentModel } from "../dist/models/VoiceAgent.js";
import { PhoneNumberModel } from "../dist/models/PhoneNumber.js";

async function main() {
  await connectDatabase();
  const webAgent = await VoiceAgentModel.findById("6a818ee880e87c6c405274b3");
  console.log("WebAgent:", webAgent ? {
    id: String(webAgent._id),
    ownerId: String(webAgent.ownerId),
    name: webAgent.name,
    phone: webAgent.phone,
    voice: webAgent.voice,
    ttsProvider: webAgent.ttsProvider,
    language: webAgent.language
  } : "not found");

  const readyPhones = await PhoneNumberModel.find({
    status: "Ready",
    direction: { $in: ["Outbound", "Both"] }
  }).limit(5);

  console.log("Ready Phones:", readyPhones.map(p => ({
    id: String(p._id),
    num: p.number,
    prov: p.provider,
    ownerId: String(p.ownerId),
    agentId: String(p.agentId || "")
  })));

  process.exit(0);
}

main().catch(console.error);
