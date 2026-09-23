import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

async function main() {
  await connectDatabase();
  const websiteAgent = await VoiceAgentModel.findById("6a818ee880e87c6c405274b3");
  console.log("=== 6a818ee880e87c6c405274b3 widget ===");
  console.log(websiteAgent?.widget);

  const saketAgent = await VoiceAgentModel.findById("6a951bbf35cda72c82172ec9");
  console.log("=== Hotel Saket Villa widget ===");
  console.log(saketAgent?.widget);

  process.exit(0);
}

main().catch(console.error);
