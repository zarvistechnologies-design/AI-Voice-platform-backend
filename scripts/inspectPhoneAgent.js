import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../dist/config/database.js";
import { VoiceAgentModel } from "../dist/models/VoiceAgent.js";
import { PhoneNumberModel } from "../dist/models/PhoneNumber.js";

async function main() {
  await connectDatabase();
  const phone = await PhoneNumberModel.findOne({ status: "Ready", direction: { $in: ["Outbound", "Both"] } });
  console.log("Ready phone found:", phone ? { id: phone.id, num: phone.number, agentId: phone.agentId, prov: phone.provider } : "none");

  if (phone && phone.agentId) {
    const agent = await VoiceAgentModel.findById(phone.agentId);
    console.log("Assigned agent:", agent ? { id: agent.id, name: agent.name, voice: agent.voice, lang: agent.language } : "none");
  }
  process.exit(0);
}

main().catch(console.error);
