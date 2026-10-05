import { connectDatabase } from "../src/config/database.js";
import { VoiceAgent } from "../src/models/VoiceAgent.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";

async function main() {
  await connectDatabase();
  const lastCalls = await CallDetailRecordModel.find().sort({ createdAt: -1 }).limit(3).lean();
  console.log("Last calls:", JSON.stringify(lastCalls.map(c => ({ id: c._id, roomName: c.roomName, status: c.status, error: c.errorMessage, metadata: c.metadata, createdAt: c.createdAt })), null, 2));
  const lastAgents = await VoiceAgent.find().sort({ updatedAt: -1 }).limit(5).lean();
  console.log("Last agents:", JSON.stringify(lastAgents.map(a => ({ name: a.name, pipelineMode: a.pipelineMode, realtimeModel: a.realtimeModel, realtimeProvider: a.realtimeProvider, ttsModel: a.ttsModel })), null, 2));
  process.exit(0);
}
main().catch(err => {
  console.error(err);
  process.exit(1);
});
