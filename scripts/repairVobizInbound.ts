import mongoose, { startSession } from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../src/models/VoiceAgent.js";
import { getVobizCredentials } from "../src/services/integrationService.js";
import {
  createInboundRoute,
  finalizeInboundRoute,
  rollbackInboundRoute,
} from "../src/services/livekitService.js";
import { acquirePhoneNumberMutation } from "../src/services/phoneNumberMutationService.js";
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
  const candidate = await PhoneNumberModel.findOne({ ownerId, number: phoneNumber, provider: "Vobiz" });
  if (!candidate) throw new Error("The Vobiz number is not in this account's inventory.");
  const phoneMutation = await acquirePhoneNumberMutation(ownerId, candidate.id);
  try {
    const phone = phoneMutation.phone;
    if (phone.direction === "Outbound") throw new Error("This number is configured as outbound-only.");
    if (!phone.agentId) throw new Error("Link an agent before repairing inbound routing.");

    const agent = await VoiceAgentModel.findOne({ _id: phone.agentId, ownerId }) as VoiceAgentDocument | null;
    if (!agent) throw new Error("The linked agent no longer exists.");
    if (agent.status !== "Live") throw new Error(`Set agent \"${agent.name}\" to Live before repairing inbound routing.`);

    const credentials = await getVobizCredentials(ownerId);
    await phoneMutation.updateLocked({ $set: { status: "Needs setup" } });
    const vobizRoute = await configureVobizLiveKitInbound(credentials, phone.number);
    await phoneMutation.assertHeld();
    const routeChange = await createInboundRoute(
      agent,
      phone.number,
      phoneMutation.token,
      phone.dispatchRuleId,
    );
    const livekitRoute = routeChange.route;
    const dispatchRuleId = livekitRoute.sipDispatchRuleId;
    const inboundTrunkId = livekitRoute.trunkIds[0] ?? "";
    if (!dispatchRuleId || !inboundTrunkId) {
      await rollbackInboundRoute(routeChange).catch(() => undefined);
      throw new Error("LiveKit did not return a complete inbound route.");
    }

    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        await phoneMutation.updateLocked(
          {
            $set: {
              inboundTrunkId,
              outboundTrunkId: phone.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId,
              dispatchRuleId,
              status: "Ready",
            },
          },
          session,
        );
        const assigned = await VoiceAgentModel.updateOne(
          { _id: agent._id, ownerId },
          { $set: { phone: phone.number } },
          { session },
        );
        if (assigned.matchedCount !== 1) throw new Error("The linked agent changed during repair.");
      });
    } catch (error) {
      await rollbackInboundRoute(routeChange).catch(() => undefined);
      throw error;
    } finally {
      await session.endSession();
    }
    await phoneMutation.assertHeld()
      .then(() => finalizeInboundRoute(routeChange))
      .catch((error) => {
        console.error(`Inbound route committed, but stale-route cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    console.log(JSON.stringify({
      number: phone.number,
      status: "Ready",
      agent: { name: agent.name, status: agent.status },
      vobiz: {
        trunk: mask(vobizRoute.trunkId),
        destination: vobizRoute.inboundDestination,
        reassigned: vobizRoute.reassigned,
      },
      livekit: {
        inboundTrunk: mask(inboundTrunkId),
        dispatchRule: mask(dispatchRuleId),
        outboundTrunk: mask(phone.direction === "Inbound" ? "" : env.livekitSipOutboundTrunkId),
      },
    }, null, 2));
  } finally {
    await phoneMutation.release().catch(() => undefined);
  }
} finally {
  await mongoose.disconnect();
}
