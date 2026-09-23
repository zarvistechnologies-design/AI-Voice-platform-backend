import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../src/config/database.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";

async function main() {
  await connectDatabase();
  const calls = await CallDetailRecordModel.find({})
    .sort({ createdAt: -1 })
    .limit(8);

  console.log("Found calls count:", calls.length);
  for (const call of calls) {
    console.log("==========================================");
    console.log({
      id: call._id.toString(),
      agentName: call.agentName,
      direction: call.direction,
      customerPhoneNumber: call.customerPhoneNumber,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      status: call.status,
      endReason: call.endReason,
      errorMessage: call.errorMessage,
      durationSeconds: call.durationSeconds,
      transcriptCount: call.transcript?.length,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      createdAt: call.createdAt,
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
