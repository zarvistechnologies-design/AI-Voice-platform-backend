import { connectDatabase } from "../config/database.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";

async function run() {
  await connectDatabase();
  const phones = await PhoneNumberModel.find().lean();
  console.log("PHONES_COUNT:", phones.length);
  console.log("PHONES:", JSON.stringify(phones, null, 2));

  const targetAgent = await VoiceAgentModel.findOne({ name: "dont touch it" }).lean();
  console.log("DONT_TOUCH_IT_AGENT:", JSON.stringify(targetAgent, null, 2));

  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
