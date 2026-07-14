import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { releaseTerminalFinalizationDeferral } from "./callRecordService.js";
import { endCallRooms } from "./livekitService.js";

/**
 * Recover the narrow crash window after a cancellation was persisted but
 * before its request could verify room cleanup and release finalization.
 * Setup-pending calls are deliberately excluded: only their exact setup owner
 * (or the operator recovery workflow) may prove they cannot create a room.
 */
export async function recoverDeferredTerminalCallFinalizations(limit = 50) {
  const calls = await CallDetailRecordModel.find({
    status: "cancelled",
    terminalFinalizationDeferred: true,
    outboundSetupPending: { $ne: true },
  })
    .select("livekitRoomName")
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(limit, 200)))
    .lean();
  if (!calls.length) return { inspected: 0, released: 0, blocked: 0, failed: 0 };

  const roomNames = [...new Set(calls.map((call) => call.livekitRoomName).filter(Boolean))];
  let failedRooms: Set<string>;
  try {
    failedRooms = new Set(await endCallRooms(roomNames));
  } catch (error) {
    console.error(JSON.stringify({
      event: "deferred-call-room-recovery-failed",
      inspected: calls.length,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { inspected: calls.length, released: 0, blocked: calls.length, failed: calls.length };
  }

  const eligible = calls.filter((call) => !failedRooms.has(call.livekitRoomName));
  const results = await Promise.allSettled(eligible.map(async (call) => {
    await releaseTerminalFinalizationDeferral(call.livekitRoomName);
  }));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) {
    console.error(JSON.stringify({
      event: "deferred-call-finalization-recovery-failed",
      inspected: calls.length,
      eligible: eligible.length,
      failed,
    }));
  }
  return {
    inspected: calls.length,
    released: eligible.length - failed,
    blocked: failedRooms.size,
    failed,
  };
}
