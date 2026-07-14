import mongoose from "mongoose";
import { SipClient } from "livekit-server-sdk";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { acquirePhoneNumberMutation } from "../src/services/phoneNumberMutationService.js";

const ownerId = process.argv[2]?.trim();
const phoneNumber = process.argv[3]?.trim();
if (!ownerId || !/^\+\d{7,15}$/.test(phoneNumber ?? "")) {
  throw new Error("Usage: tsx scripts/setVobizOutboundOnly.ts <ownerId> <E.164 phone number>");
}

await connectDatabase();

try {
  const candidate = await PhoneNumberModel.findOne({ ownerId, number: phoneNumber, provider: "Vobiz" });
  if (!candidate) throw new Error("The Vobiz number is not in this account's inventory.");
  const phoneMutation = await acquirePhoneNumberMutation(ownerId, candidate.id);
  try {
    const phone = phoneMutation.phone;
    const apiUrl = env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const sip = new SipClient(apiUrl, env.livekitApiKey, env.livekitApiSecret);
    const roomPrefix = `inbound-${phone.number.replace(/\D/g, "")}-`;
    const rules = await sip.listSipDispatchRule();
    const staleRules = rules.filter((rule) => {
      const rulePrefix = rule.rule?.rule.case === "dispatchRuleIndividual"
        ? rule.rule.rule.value.roomPrefix
        : "";
      return rulePrefix === roomPrefix || rule.name.endsWith(` - ${phone.number}`);
    });
    for (const rule of staleRules) {
      await sip.deleteSipDispatchRule(rule.sipDispatchRuleId);
    }

    const agent = phone.agentId
      ? await VoiceAgentModel.findOne({ _id: phone.agentId, ownerId }).select("status")
      : null;
    const status = agent?.status === "Live" && env.livekitSipOutboundTrunkId ? "Ready" : "Needs setup";
    await phoneMutation.updateLocked({
      $set: {
        direction: "Outbound",
        inboundTrunkId: "",
        dispatchRuleId: "",
        outboundTrunkId: env.livekitSipOutboundTrunkId,
        status,
      },
    });

    console.log(JSON.stringify({
      number: phone.number,
      direction: "Outbound",
      status,
      removedInboundRules: staleRules.length,
    }, null, 2));
  } finally {
    await phoneMutation.release().catch(() => undefined);
  }
} finally {
  await mongoose.disconnect();
}
