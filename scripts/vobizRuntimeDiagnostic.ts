import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { PhoneNumberModel } from "../src/models/PhoneNumber.js";
import "../src/models/VoiceAgent.js";
import { getVobizCredentials } from "../src/services/integrationService.js";
import { listVobizOwnedNumbers, listVobizTrunks } from "../src/services/vobizService.js";

const ownerId = process.argv[2]?.trim();
if (!ownerId) throw new Error("Usage: tsx scripts/vobizRuntimeDiagnostic.ts <ownerId>");

function mask(value: unknown) {
  const text = String(value ?? "");
  return text ? `***${text.slice(-4)}` : "";
}

await connectDatabase();

try {
  const routes = await PhoneNumberModel.find({ ownerId, provider: "Vobiz" })
    .populate("agentId")
    .lean();
  const credentials = await getVobizCredentials(ownerId);
  const [numbers, trunks, uriResponse] = await Promise.all([
    listVobizOwnedNumbers(credentials),
    listVobizTrunks(credentials),
    fetch(
      `${env.vobizBaseUrl.replace(/\/$/, "")}/v1/Account/${encodeURIComponent(credentials.authId)}/trunks/origination-uris?limit=100&offset=0`,
      { headers: { "X-Auth-ID": credentials.authId, "X-Auth-Token": credentials.authToken } },
    ),
  ]);
  const uriBody = await uriResponse.json().catch(() => null) as {
    objects?: Array<{ id: string; uri: string; priority: number; weight: number; enabled: boolean; transport: string }>;
  } | null;

  console.log(JSON.stringify({
    numbers: numbers.items.map((number) => {
      const routing = number as typeof number & {
        trunk_group_id?: string | null;
        is_trial_number?: boolean;
        account_id?: string;
      };
      return {
        e164: number.e164,
        status: number.status,
        voice: number.voice_enabled ?? number.capabilities?.voice,
        assignedTrunk: mask(routing.trunk_group_id),
        trial: routing.is_trial_number ?? false,
        account: mask(routing.account_id),
      };
    }),
    trunks: trunks.objects.map((trunk) => ({
      id: mask(trunk.trunk_id),
      name: trunk.name,
      status: trunk.trunk_status,
      direction: trunk.trunk_direction,
      destination: trunk.inbound_destination ?? "",
      primaryUri: mask(trunk.primary_uri_uuid),
    })),
    originationUris: (uriBody?.objects ?? []).map((uri) => ({
      id: mask(uri.id),
      uri: uri.uri,
      priority: uri.priority,
      weight: uri.weight,
      enabled: uri.enabled,
      transport: uri.transport,
    })),
    routes: routes.map((route) => {
      const agent = route.agentId && typeof route.agentId === "object"
        ? route.agentId as unknown as { name?: string; status?: string }
        : null;
      return {
        id: String(route._id),
        number: route.number,
        direction: route.direction,
        status: route.status,
        providerNumberId: route.providerNumberId,
        agent: agent ? { name: agent.name, status: agent.status } : null,
        inboundTrunk: mask(route.inboundTrunkId),
        dispatchRule: mask(route.dispatchRuleId),
        outboundTrunk: mask(route.outboundTrunkId),
      };
    }),
  }, null, 2));
} finally {
  await mongoose.disconnect();
}
