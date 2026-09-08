/** Job room data exists before the RTC connection populates Room.name/metadata. */
export function voiceJobRoomContext(ctx: {
  job: { metadata?: string; room?: { name?: string; metadata?: string } };
  room: { name?: string; metadata?: string };
}) {
  const roomName = ctx.job.room?.name || ctx.room.name;
  if (!roomName) throw new Error("Voice job is missing its room name.");
  return {
    roomName,
    metadata: ctx.job.metadata || ctx.job.room?.metadata || ctx.room.metadata || "",
  };
}

/** Bound optional reads including pool/network waiting, not just DB execution. */
export async function optionalVoiceContext<T>(read: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
