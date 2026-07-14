import { RoomServiceClient } from "livekit-server-sdk";

import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberCallAdmissionModel } from "../models/PhoneNumberCallAdmission.js";
import { finalizeTerminalCall } from "./callRecordService.js";

function liveKitApiUrl() {
  return env.livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function closeAndVerifyLiveKitRoom(roomName: string) {
  if (!roomName || !env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) return false;
  const rooms = new RoomServiceClient(liveKitApiUrl(), env.livekitApiKey, env.livekitApiSecret);

  for (const delay of [0, 200, 750] as const) {
    if (delay) await wait(delay);
    await rooms.deleteRoom(roomName).catch(() => undefined);
    const absent = await rooms.listRooms([roomName])
      .then((items) => !items.some((item) => item.name === roomName))
      .catch(() => false);
    if (absent) return true;
  }
  return false;
}

type RecoveryFilter = {
  ownerId?: string;
  phoneNumberId?: string;
  campaignId?: string;
  callId?: string;
};

export async function recoverOutboundSetupsAfterProcessDrain(
  filter: RecoveryFilter,
  options: { processesDrained: true; limit?: number },
) {
  if (options.processesDrained !== true) {
    throw new Error("Outbound setup recovery requires confirmed process drain.");
  }
  if (!filter.callId && !filter.phoneNumberId && !filter.campaignId) {
    throw new Error("Outbound setup recovery requires a call, phone-number, or campaign id scope.");
  }
  const candidateFilter = {
    ...(filter.callId ? { _id: filter.callId } : {}),
    ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
    ...(filter.phoneNumberId ? { phoneNumberId: filter.phoneNumberId } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    direction: "outbound",
    outboundSetupPending: true,
  };
  const candidates = await CallDetailRecordModel.find(candidateFilter)
    .select(
      "+outboundSetupToken +terminalFinalizationStatus "
      + "livekitRoomName phoneNumberId campaignId status startedAt createdAt",
    )
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Math.min(options.limit ?? 20, 100)));

  let recovered = 0;
  let blocked = 0;
  for (const call of candidates) {
    const setupToken = call.outboundSetupToken;
    if (!setupToken) {
      // A pending guard without its fence cannot be safely recovered by CAS.
      blocked += 1;
      continue;
    }

    const activeAdmission = await PhoneNumberCallAdmissionModel.exists({
      setupToken,
      expiresAt: { $gt: new Date() },
    });
    if (activeAdmission) {
      blocked += 1;
      continue;
    }

    const roomClosed = await closeAndVerifyLiveKitRoom(call.livekitRoomName);
    if (!roomClosed) {
      blocked += 1;
      await CallDetailRecordModel.updateOne(
        { _id: call._id, outboundSetupPending: true, outboundSetupToken: setupToken },
        { $set: { outboundSetupStage: "cleanup_required" } },
      ).catch(() => undefined);
      continue;
    }

    const completedAt = new Date();
    const openStatus = ["initiated", "ringing", "active"].includes(call.status);
    const terminalFinalizationNeedsRetry = !openStatus
      && call.terminalFinalizationStatus !== "completed";
    const cleared = await CallDetailRecordModel.updateOne(
      {
        _id: call._id,
        status: call.status,
        outboundSetupPending: true,
        outboundSetupToken: setupToken,
      },
      {
        $set: {
          outboundSetupPending: false,
          outboundSetupToken: "",
          outboundSetupStage: "aborted",
          outboundSetupCompletedAt: completedAt,
          // Campaign cancellation deliberately defers terminal side effects
          // until the room is proven absent. Recovery owns that proof, so it
          // must release the deferral in the same CAS that clears the setup
          // guard. A drained process cannot still own a processing lease.
          terminalFinalizationDeferred: false,
          ...(openStatus
            ? {
                status: "failed",
                endedAt: completedAt,
                durationSeconds: call.startedAt
                  ? Math.max(0, Math.floor((completedAt.getTime() - call.startedAt.getTime()) / 1000))
                  : 0,
                endReason: "outbound_setup_recovered",
                errorMessage: "A stale outbound setup was closed after its owning processes were drained.",
                terminalFinalizationStatus: "pending",
                terminalFinalizationToken: "",
                terminalFinalizationLeaseUntil: null,
                terminalFinalizationAttempts: 0,
                terminalFinalizationError: "",
                terminalFinalizationDueAt: completedAt,
                terminalRuntimeClosedAt: completedAt,
                terminalFinalizedAt: null,
              }
            : {}),
          ...(terminalFinalizationNeedsRetry
            ? {
                terminalFinalizationStatus: "pending",
                terminalFinalizationToken: "",
                terminalFinalizationLeaseUntil: null,
                terminalFinalizationError: "",
                terminalFinalizationDueAt: completedAt,
                terminalRuntimeClosedAt: completedAt,
              }
            : {}),
        },
        $inc: { terminalDataRevision: openStatus || terminalFinalizationNeedsRetry ? 1 : 0 },
      },
    );
    if (cleared.matchedCount !== 1) {
      // Never report success when the exact guarded record changed between
      // inspection and repair. A retry must re-read and re-prove cleanup for
      // the new state.
      blocked += 1;
      continue;
    }
    await finalizeTerminalCall(call.livekitRoomName);
    recovered += 1;
  }

  // A broad phone/campaign scope can exceed the bounded batch. Do not let the
  // operator restart replicas while any durable setup guard in scope remains.
  const remaining = await CallDetailRecordModel.countDocuments(candidateFilter);
  return { recovered, blocked, inspected: candidates.length, remaining };
}
