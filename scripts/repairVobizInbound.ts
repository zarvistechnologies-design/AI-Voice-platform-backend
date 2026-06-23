import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../src/models/VoiceAgent.js";
import { getVobizCredentials } from "../src/services/integrationService.js";
import { createInboundRoute } from "../src/services/livekitService.js";
import { configureVobizLiveKitInbound } from "../src/services/vobizService.js";

const ownerId = process.argv[2]?.trim();
const phoneNumber = process.argv[3]?.trim();
if (!ownerId || !/^\+\d{7,15}$/.test(phoneNumber ?? "")) {
  throw new Error("Usage: tsx scripts/repairVobizInbound.ts <ownerId> <E.164 phone number>");
}

function mask(value: unknown) {
  const text = String(value ?? "");
  return text ? `***${text.slice(-4)}` : "";
}

await connectDatabase();

try {
  const phone = await PhoneNumberModel.findOne({ ownerId, number: phoneNumber, provider: "Vobiz" });
  if (!phone) throw new Error("The Vobiz number is not in this account's inventory.");
  if (phone.direction === "Outbound") throw new Error("This number is configured as outbound-only.");
  if (!phone.agentId) throw new Error("Link an agent before repairing inbound routing.");

  const agent = await VoiceAgentModel.findOne({ _id: phone.agentId, ownerId }) as VoiceAgentDocument | null;
  if (!agent) throw new Error("The linked agent no longer exists.");
  if (agent.status !== "Live") throw new Error(`Set agent \"${agent.name}\" to Live before repairing inbound routing.`);

  const credentials = await getVobizCredentials(ownerId);
  const vobizRoute = await configureVobizLiveKitInbound(credentials, phone.number);
  const livekitRoute = await createInboundRoute(agent, phone.number);
  const dispatchRuleId = livekitRoute.sipDispatchRuleId;
  const inboundTrunkId = livekitRoute.trunkIds[0] ?? "";
  if (!dispatchRuleId || !inboundTrunkId) {
    throw new Error("LiveKit did not return a complete inbound route.");
  }

  phone.inboundTrunkId = inboundTrunkId;
  phone.outboundTrunkId = phone.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId;
  phone.dispatchRuleId = dispatchRuleId;
  phone.status = "Ready";
  await phone.save();

  agent.phone = phone.number;
  await agent.save();

  console.log(JSON.stringify({
    number: phone.number,
    status: phone.status,
    agent: { name: agent.name, status: agent.status },
    vobiz: {
      trunk: mask(vobizRoute.trunkId),
      destination: vobizRoute.inboundDestination,
      reassigned: vobizRoute.reassigned,
    },
    livekit: {
      inboundTrunk: mask(inboundTrunkId),
      dispatchRule: mask(dispatchRuleId),
      outboundTrunk: mask(phone.outboundTrunkId),
    },
  }, null, 2));
} finally {
  await mongoose.disconnect();
}
