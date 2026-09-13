import { ParticipantKind, RoomEvent, type Participant, type RemoteParticipant, type Room } from "@livekit/rtc-node";

export function waitForCallerReady(
  room: Room | undefined,
  expectedIdentity = "",
  requireSipAnswer = false,
  timeoutMs = 45_000,
): Promise<RemoteParticipant | null> {
  if (!room) return Promise.resolve(null);
  const matches = (participant: RemoteParticipant) =>
    (!expectedIdentity || participant.identity === expectedIdentity)
    && (participant.kind ?? participant.info.kind) !== ParticipantKind.AGENT;
  const ready = (participant: RemoteParticipant) => matches(participant)
    && (!requireSipAnswer || participant.attributes["sip.callStatus"] === "active");
  const existing = [...room.remoteParticipants.values()].find(ready);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const finish = (participant: RemoteParticipant | null) => {
      clearTimeout(timeout);
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      resolve(participant);
    };
    const onConnected = (participant: RemoteParticipant) => {
      if (ready(participant)) finish(participant);
      else if (matches(participant) && participant.attributes["sip.callStatus"] === "hangup") finish(null);
    };
    const onAttributesChanged = (_attributes: Record<string, string>, participant: Participant) => {
      const remote = room.remoteParticipants.get(participant.identity);
      if (remote) onConnected(remote);
    };
    const onParticipantDisconnected = (participant: RemoteParticipant) => {
      if (matches(participant)) finish(null);
    };
    const onDisconnected = () => finish(null);
    // Never fall back to a participant that is still dialing at the deadline.
    const timeout = setTimeout(() => finish(null), timeoutMs);
    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
  });
}
