import type { Request, Response } from "express";
import { WebhookReceiver } from "livekit-server-sdk";

import { env } from "../config/env.js";
import {
  completeCall,
  ensureCallRecordForRoom,
  markCallActive,
  updateCallRecording,
  updateCallParticipant,
} from "../services/callRecordService.js";
import { HttpError } from "../utils/httpError.js";

const receiver = new WebhookReceiver(env.livekitApiKey, env.livekitApiSecret);

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
    await markCallActive(roomName, event.room?.metadata);
    if (event.participant) await updateCallParticipant(roomName, event.participant);
  } else if (event.event === "room_finished") {
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
