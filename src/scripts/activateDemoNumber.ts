import { connectDatabase } from "../config/database.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";

async function run() {
  await connectDatabase();
  const agent = await VoiceAgentModel.findOne({ name: "dont touch it" });
  if (!agent) {
    throw new Error("Could not find 'dont touch it' agent");
  }

  const phone = await PhoneNumberModel.findOneAndUpdate(
    { number: "+918071584457" },
    {
      $set: {
        status: "Ready",
        direction: "Both",
        provider: "Vobiz",
        outboundTrunkId: "ST_2Yueg64uh65Q",
        agentId: agent._id,
        ownerId: agent.ownerId,
        lifecycle: "active",
      },
    },
    { new: true },
  );

  console.log("UPDATED_PHONE:", JSON.stringify(phone, null, 2));
  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
