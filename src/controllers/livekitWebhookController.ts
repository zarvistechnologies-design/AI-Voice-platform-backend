import type { Request, Response } from "express";
import { ParticipantInfo_Kind, type ParticipantInfo } from "@livekit/protocol";
import { WebhookReceiver } from "livekit-server-sdk";

import { env } from "../config/env.js";
import {
  completeCall,
  ensureCallRecordForRoom,
  failCall,
  markCallActive,
  updateCallRecording,
  updateCallParticipant,
} from "../services/callRecordService.js";
import { endCallRooms, refreshCallParticipantNumbers } from "../services/livekitService.js";
import { HttpError } from "../utils/httpError.js";

const receiver = new WebhookReceiver(env.livekitApiKey, env.livekitApiSecret);

export function isOutboundCallerParticipant(
  roomName: string,
  participant: Pick<ParticipantInfo, "identity" | "kind"> | undefined,
) {
  if (!roomName.startsWith("outbound-call-") || !participant) return false;
  return participant.kind === ParticipantInfo_Kind.SIP || participant.identity.startsWith("phone-");
}

async function finishOutboundCallAfterCallerDeparture(
  roomName: string,
  eventName: "participant_left" | "participant_connection_aborted",
) {
  // The SIP leg has ended, so persist the real end time immediately instead of
  // waiting for the agent worker or room idle timeout. The terminal transition
  // is a CAS, so a later room_finished event cannot overwrite this result.
  if (eventName === "participant_left") {
    await completeCall(roomName, "participant_disconnected");
  } else {
    await failCall(
      roomName,
      "The outbound SIP participant disconnected before the call was established.",
      "participant_connection_aborted",
    );
  }

  const failedRooms = await endCallRooms([roomName]).catch((error) => {
    console.error(JSON.stringify({
      event: "outbound-caller-departure-room-close-failed",
      roomName,
      error: error instanceof Error ? error.message : String(error),
    }));
    return [roomName];
  });
  if (failedRooms.length) {
    console.error(JSON.stringify({
      event: "outbound-caller-departure-room-still-open",
      roomName,
    }));
  }
}

function retryParticipantNumberRefresh(roomName: string) {
  setTimeout(() => {
    void refreshCallParticipantNumbers(roomName).catch((error) => {
      console.error(JSON.stringify({
        event: "livekit-participant-number-refresh-failed",
        roomName,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }, 2500);
}

export async function receiveLivekitWebhook(request: Request, response: Response) {
  if (!env.livekitApiKey || !env.livekitApiSecret) {
    throw new HttpError(503, "LiveKit webhook validation is not configured.");
  }
  const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body);
  const event = await receiver.receive(body, request.headers.authorization);
  const roomName = event.room?.name || event.egressInfo?.roomName;
  if (!roomName) {
    response.status(204).end();
    return;
  }

  if (event.event === "room_started") {
    await ensureCallRecordForRoom(roomName, event.room?.metadata);
  } else if (event.event === "participant_joined") {
    if (roomName.startsWith("inbound-")) {
      // Inbound route metadata is only a locator. The agent worker owns the
      // active transition after it has loaded the authoritative MongoDB agent,
      // so call.started can never be emitted with a stale model snapshot.
      await ensureCallRecordForRoom(roomName, event.room?.metadata);
    } else {
      await markCallActive(roomName, event.room?.metadata);
    }
    if (event.participant) await updateCallParticipant(roomName, event.participant);
    await refreshCallParticipantNumbers(roomName).catch(() => undefined);
    retryParticipantNumberRefresh(roomName);
  } else if (event.event === "participant_left" || event.event === "participant_connection_aborted") {
    if (event.participant) await updateCallParticipant(roomName, event.participant);
    if (isOutboundCallerParticipant(roomName, event.participant)) {
      await finishOutboundCallAfterCallerDeparture(roomName, event.event);
    }
  } else if (event.event === "track_published" || event.event === "track_unpublished") {
    if (event.participant) await updateCallParticipant(roomName, event.participant);
  } else if (event.event === "room_finished") {
    await refreshCallParticipantNumbers(roomName).catch(() => undefined);
    await completeCall(roomName, "room_finished");
  } else if (event.event.startsWith("egress_") && event.egressInfo) {
    const egress = event.egressInfo;
    const file = egress.fileResults[0] ?? (egress.result.case === "file" ? egress.result.value : undefined);
    const failed = Boolean(egress.error);
    await updateCallRecording({
      roomName: egress.roomName || roomName,
      egressId: egress.egressId,
      status: event.event === "egress_ended" ? (failed ? "failed" : "completed") : "active",
      key: file?.filename,
      url: file?.location,
      durationSeconds: file ? Number(file.duration) / 1_000_000_000 : undefined,
      error: egress.error || egress.details,
    });
  }

  response.status(204).end();
}
