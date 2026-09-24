import { connectDatabase } from "../config/database.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";

async function run() {
  await connectDatabase();
  const call = await CallDetailRecordModel.findOne().sort({ createdAt: -1 }).select("+outboundSetupToken").lean();
  console.log("LATEST_CDR:", JSON.stringify(call, null, 2));
  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
