import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";

async function main() {
  await connectDatabase();
  const agent = await VoiceAgentModel.findById("6a818ee880e87c6c405274b3");
  if (!agent) throw new Error("Agent 6a818ee880e87c6c405274b3 not found");

  const currentDomains = agent.widget?.allowedDomains || [];
  const domainsToAdd = [
    "http://localhost:3000",
    "http://localhost:3000/",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3000/",
    "https://vozon.ai",
    "https://vozon.ai/",
  ];

  const uniqueDomains = Array.from(new Set([...currentDomains, ...domainsToAdd]));
  agent.widget = {
    ...agent.widget,
    enabled: true,
    publicKey: "wpk_f2fc6a2375744227a4bf3c53889816dc",
    allowedDomains: uniqueDomains,
    theme: "auto",
    position: "bottom-right",
    buttonText: "Talk to us",
    accentColor: "#108D82",
  };
  agent.status = "Live";
  agent.multilingualEnabled = true;
  agent.languageSwitchingEnabled = true;

  await agent.save();
  console.log("Updated Vozon Website Assistant widget settings successfully.");
  console.log("Allowed domains:", uniqueDomains);
  process.exit(0);
}

main().catch(console.error);
