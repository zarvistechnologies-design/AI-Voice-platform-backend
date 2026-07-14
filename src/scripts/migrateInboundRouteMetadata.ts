import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { refreshInboundRoutesForAgent } from "../services/livekitService.js";

async function migrateInboundRouteMetadata() {
  await connectDatabase();

  const assignedNumbers = await PhoneNumberModel.find({
    agentId: { $ne: null },
    direction: { $in: ["Inbound", "Both"] },
  }).select("ownerId agentId number").lean();
  const agentIds = [
    ...new Set(
      assignedNumbers
        .map((phone) => phone.agentId ? String(phone.agentId) : "")
        .filter(Boolean),
    ),
  ];
  const agents = await VoiceAgentModel.find({ _id: { $in: agentIds } });
  const agentOwners = new Map(agents.map((agent) => [agent.id, String(agent.ownerId)]));
  const errors = assignedNumbers.flatMap((phone) => {
    const assignedAgentId = phone.agentId ? String(phone.agentId) : "";
    const assignedAgentOwner = agentOwners.get(assignedAgentId);
    if (!assignedAgentOwner) return [`${phone.number}: assigned agent no longer exists`];
    if (assignedAgentOwner !== phone.ownerId) {
      return [`${phone.number}: assigned agent belongs to another workspace`];
    }
    return [];
  });
  let refreshed = 0;

  for (const agent of agents) {
    const result = await refreshInboundRoutesForAgent(agent);
    refreshed += result.refreshed;
    errors.push(...result.errors);
  }

  if (refreshed + errors.length !== assignedNumbers.length) {
    errors.push(
      `Migration coverage mismatch: accounted for ${refreshed + errors.length} of ${assignedNumbers.length} assigned numbers`,
    );
  }

  console.log(JSON.stringify({
    event: "inbound-route-metadata-migration-finished",
    assignedNumbers: assignedNumbers.length,
    agents: agents.length,
    refreshed,
    errors,
  }));

  if (errors.length) process.exitCode = 1;
}

migrateInboundRouteMetadata()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "inbound-route-metadata-migration-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
