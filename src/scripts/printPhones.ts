import { connectDatabase } from "../config/database.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";

async function run() {
  await connectDatabase();
  const phones = await PhoneNumberModel.find().lean();
  for (const p of phones) {
    console.log({
      _id: p._id,
      number: p.number,
      agentId: p.agentId,
      status: p.status,
      direction: p.direction,
      provider: p.provider,
      outboundTrunkId: p.outboundTrunkId,
      ownerId: p.ownerId,
    });
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
