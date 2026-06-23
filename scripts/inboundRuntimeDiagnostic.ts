import mongoose from "mongoose";
import { AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";

function mask(value: unknown) {
  const text = String(value ?? "");
  return text ? `***${text.slice(-4)}` : "";
}

await connectDatabase();

const recent = await CallDetailRecordModel.find({ direction: "inbound" })
  .sort({ createdAt: -1 })
  .limit(10)
  .lean();

const apiUrl = env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const rooms = new RoomServiceClient(apiUrl, env.livekitApiKey, env.livekitApiSecret);
const dispatches = new AgentDispatchClient(apiUrl, env.livekitApiKey, env.livekitApiSecret);
const sip = new SipClient(apiUrl, env.livekitApiKey, env.livekitApiSecret);

const runtime: Record<string, unknown>[] = [];
for (const call of recent.slice(0, 5)) {
  let room: Record<string, unknown> | null = null;
  let participants: Record<string, unknown>[] = [];
  let agentDispatches: Record<string, unknown>[] = [];
  let runtimeError = "";
  try {
    const [listedRooms, listedDispatches] = await Promise.all([
      rooms.listRooms([call.livekitRoomName]),
      dispatches.listDispatch(call.livekitRoomName),
    ]);
    const liveRoom = listedRooms[0];
    room = liveRoom
      ? {
          sid: mask(liveRoom.sid),
          creationTime: liveRoom.creationTime,
          numParticipants: liveRoom.numParticipants,
          numPublishers: liveRoom.numPublishers,
        }
      : null;
    if (liveRoom) {
      participants = (await rooms.listParticipants(call.livekitRoomName)).map((participant) => ({
        identity: participant.identity.startsWith("sip_") ? "sip-participant" : participant.identity,
        sid: mask(participant.sid),
        state: participant.state,
        kind: participant.kind,
        joinedAt: participant.joinedAt,
        tracks: participant.tracks.length,
      }));
    }
    agentDispatches = listedDispatches.map((dispatch) => ({
      id: mask(dispatch.id),
      agentName: dispatch.agentName,
      jobs: dispatch.state?.jobs.map((job) => ({
        id: mask(job.id),
        status: job.state?.status,
        error: job.state?.error ?? "",
        workerId: mask(job.state?.workerId),
      })) ?? [],
    }));
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  }
  runtime.push({ roomName: call.livekitRoomName, room, participants, agentDispatches, runtimeError });
}

const [trunks, rules] = await Promise.all([
  sip.listSipInboundTrunk(),
  sip.listSipDispatchRule(),
]);

console.log(JSON.stringify({
  recentCalls: recent.map((call) => ({
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    status: call.status,
    endReason: call.endReason,
    errorMessage: call.errorMessage,
    roomName: call.livekitRoomName,
    caller: mask(call.callerNumber),
    called: mask(call.calledNumber),
    participant: mask(call.livekitParticipantId),
    transcriptItems: call.transcript.length,
    llmTokens: call.llmTokens,
    sttSeconds: call.sttSeconds,
    ttsCharacters: call.ttsCharacters,
  })),
  runtime,
  routing: {
    trunks: trunks.map((trunk) => ({
      id: mask(trunk.sipTrunkId),
      name: trunk.name,
      numberCount: trunk.numbers.length,
      allowedAddresses: trunk.allowedAddresses,
    })),
    rules: rules.map((rule) => ({
      id: mask(rule.sipDispatchRuleId),
      name: rule.name,
      trunks: rule.trunkIds.map(mask),
      callerFilters: rule.inboundNumbers.length,
      calledFilters: rule.numbers.length,
      prefix: rule.rule?.rule.case === "dispatchRuleIndividual"
        ? rule.rule.rule.value.roomPrefix
        : "",
      agents: rule.roomConfig?.agents.map((agent) => agent.agentName) ?? [],
    })),
  },
}, null, 2));

await mongoose.disconnect();
