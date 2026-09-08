import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from "@livekit/rtc-node";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import { assertCallCapacity } from "./billingService.js";
import {
  completeCall,
  createCallRecord,
  effectiveModelSnapshot,
  failCall,
} from "./callRecordService.js";
import {
  decodeExotelPcm,
  EXOTEL_PLAYBACK_CONTROL_TOPIC,
  exotelPhoneCandidates,
  exotelSampleRate,
  ExotelPcmChunker,
  isExotelClearPlaybackMessage,
  parseExotelStreamEvent,
  type ExotelStartEvent,
  type ExotelStreamEvent,
} from "./exotelProtocol.js";
import {
  assertCallStackPriced,
  liveKitApiUrl,
  runtimeMetadataForAgent,
} from "./livekitService.js";
import {
  safelyEqualExotelCredential,
  validateExotelStreamToken,
} from "./exotelStreamAuth.js";

const MAX_STREAM_MESSAGE_BYTES = 256 * 1024;
const START_EVENT_TIMEOUT_MS = 10_000;
const MAX_STREAM_DURATION_MS = 60 * 60 * 1_000;
const MAX_WS_BUFFERED_BYTES = 1_000_000;
// Bound the bridge-side caller-audio backlog to two Exotel media windows.
// A larger queue makes the agent hear stale audio after a transient stall.
const EXOTEL_LIVEKIT_INPUT_QUEUE_MS = 200;

type BridgeRuntime = {
  agent: VoiceAgentDocument;
  audioSource: AudioSource;
  callId: string;
  outputChunker: ExotelPcmChunker;
  outputTail: { timer?: ReturnType<typeof setTimeout> };
  participantIdentity: string;
  readers: Map<string, ReadableStreamDefaultReader<AudioFrame>>;
  room: Room;
  roomName: string;
  rooms: RoomServiceClient;
  sampleRate: number;
  streamSid: string;
};

function requestCredentials(request: IncomingMessage) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const streamPrefix = `${env.exotelStreamPath.replace(/\/$/, "")}/`;
  const pathToken = url.pathname.startsWith(streamPrefix)
    ? decodeURIComponent(url.pathname.slice(streamPrefix.length))
    : "";
  const token = url.searchParams.get("token") ?? pathToken;
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Basic ")) {
    return { token, username: "", password: "" };
  }
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return {
      token,
      username: separator >= 0 ? decoded.slice(0, separator) : "",
      password: separator >= 0 ? decoded.slice(separator + 1) : "",
    };
  } catch {
    return { token, username: "", password: "" };
  }
}

export function isAuthorizedExotelStream(request: IncomingMessage) {
  const credentials = requestCredentials(request);
  const tokenAuthorized = safelyEqualExotelCredential(credentials.token, env.exotelStreamSecret);
  const signedTokenAuthorized = validateExotelStreamToken({
    secret: env.exotelStreamSecret,
    token: credentials.token,
  });
  const basicAuthorized = Boolean(
    (
      safelyEqualExotelCredential(credentials.username, "exotel")
      && safelyEqualExotelCredential(credentials.password, env.exotelStreamSecret)
    )
    || (
      safelyEqualExotelCredential(credentials.username, env.exotelStreamUsername)
      && safelyEqualExotelCredential(credentials.password, env.exotelStreamPassword)
    ),
  );
  return tokenAuthorized || signedTokenAuthorized || basicAuthorized;
}

function writeUpgradeError(socket: Duplex, status: number, message: string) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

function rawDataText(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function inboundRoomName(toPhone: string, fromPhone: string) {
  const destination = toPhone.replace(/\D/g, "");
  const caller = fromPhone.replace(/\D/g, "");
  return `inbound-${destination}-${caller || "unknown"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function dtmfCode(digit: string) {
  if (/^[0-9]$/.test(digit)) return Number(digit);
  return ({ "*": 10, "#": 11, A: 12, B: 13, C: 14, D: 15 } as Record<string, number>)[digit.toUpperCase()];
}

function sendJson(socket: WebSocket, value: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    socket.close(1013, "Audio consumer is too slow");
    return false;
  }
  socket.send(JSON.stringify(value));
  return true;
}

async function findExotelRoute(start: ExotelStartEvent) {
  const candidates = exotelPhoneCandidates(start.start?.to);
  if (!candidates.length) throw new Error("Exotel start event did not include a valid destination number.");
  const phone = await PhoneNumberModel.findOne({
    provider: "Exotel",
    number: { $in: candidates },
    status: "Ready",
    lifecycle: { $ne: "deleting" },
    direction: { $in: ["Inbound", "Both"] },
    agentId: { $ne: null },
  });
  if (!phone) {
    const diagnosticRoute = await PhoneNumberModel.findOne({
      provider: "Exotel",
      number: { $in: candidates },
      lifecycle: { $ne: "deleting" },
    }).select("number status direction agentId").lean();
    console.error(JSON.stringify({
      event: "exotel-route-not-ready",
      calledNumber: String(start.start?.to ?? ""),
      candidates,
      route: diagnosticRoute
        ? {
            number: diagnosticRoute.number,
            status: diagnosticRoute.status,
            direction: diagnosticRoute.direction,
            agentAssigned: Boolean(diagnosticRoute.agentId),
          }
        : null,
    }));
    throw new Error("No ready Exotel number route matches this call.");
  }
  const agent = await VoiceAgentModel.findOne({ _id: phone.agentId, ownerId: phone.ownerId });
  if (!agent) throw new Error("The assigned Exotel voice agent no longer exists.");
  return { agent, phone };
}

async function createBridgeRuntime(socket: WebSocket, start: ExotelStartEvent): Promise<BridgeRuntime> {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new Error("LiveKit voice routing is not configured.");
  }
  const encoding = String(start.start?.media_format?.encoding ?? "audio/x-raw").toLowerCase();
  // Exotel currently reports `base64` here to describe the JSON payload
  // transport. The decoded bytes are still raw/slin PCM16 little-endian.
  if (!["base64", "audio/x-raw", "audio/pcm", "linear16", "pcm_s16le", "slin"].includes(encoding)) {
    throw new Error(`Unsupported Exotel audio encoding: ${encoding}.`);
  }

  const sampleRate = exotelSampleRate(start);
  console.log(JSON.stringify({
    event: "exotel-bridge-setup-stage",
    stage: "route_lookup",
    calledNumber: String(start.start?.to ?? ""),
    callerNumber: String(start.start?.from ?? ""),
    sampleRate,
  }));
  const { agent, phone } = await findExotelRoute(start);
  console.log(JSON.stringify({
    event: "exotel-bridge-setup-stage",
    stage: "route_found",
    phoneNumberId: phone.id,
    agentId: agent.id,
  }));
  assertCallStackPriced(agent);
  const [activeCalls] = await Promise.all([
    CallDetailRecordModel.countDocuments({
      ownerId: phone.ownerId,
      agentId: agent._id,
      status: { $in: ["initiated", "ringing", "active"] },
    }),
    assertCallCapacity(phone.ownerId),
  ]);
  if (activeCalls >= agent.maxConcurrentCalls) {
    throw new Error(`The assigned agent has reached its ${agent.maxConcurrentCalls} concurrent call limit.`);
  }
  const fromPhone = exotelPhoneCandidates(start.start?.from)[0] ?? String(start.start?.from ?? "").trim();
  const toPhone = phone.number;
  const streamSid = String(start.start?.stream_sid ?? start.stream_sid ?? "").trim();
  const callSid = String(start.start?.call_sid ?? "").trim();
  if (!streamSid) throw new Error("Exotel start event is missing stream_sid.");

  const roomName = inboundRoomName(toPhone, fromPhone);
  const participantIdentity = `exotel-${streamSid.replace(/[^a-zA-Z0-9_-]/g, "").slice(-48) || randomUUID()}`;
  const call = await createCallRecord({
    ownerId: phone.ownerId,
    agentId: agent._id,
    phoneNumberId: phone._id,
    livekitRoomName: roomName,
    direction: "inbound",
    callerNumber: fromPhone,
    calledNumber: toPhone,
    ...effectiveModelSnapshot({
      pipelineMode: agent.pipelineMode,
      realtimeProvider: agent.realtimeProvider,
      realtimeModel: agent.realtimeModel,
      language: agent.language,
      multilingualEnabled: agent.multilingualEnabled,
      llmProvider: agent.llmProvider,
      llmModel: agent.llmModel,
      sttProvider: agent.sttProvider,
      sttModel: agent.sttModel,
      ttsProvider: agent.ttsProvider,
      ttsModel: agent.ttsModel,
      ttsVoice: agent.voice,
    }),
  });
  const metadata = runtimeMetadataForAgent(agent, call.id, {
    callDirection: "inbound",
    callerParticipantIdentity: participantIdentity,
    fromPhone,
    toPhone,
    metadata: {
      ExotelCallSid: callSid,
      ExotelStreamSid: streamSid,
      ExotelAccountSid: String(start.start?.account_sid ?? "").trim(),
      ExotelCustomParameters: start.start?.custom_parameters ?? {},
    },
  });
  const rooms = new RoomServiceClient(liveKitApiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const dispatch = new AgentDispatchClient(liveKitApiUrl(), env.livekitApiKey, env.livekitApiSecret);
  const room = new Room();
  // When the agent deletes its room, release the Exotel media connection too.
  room.on(RoomEvent.Disconnected, () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Voice call ended");
  });
  const audioSource = new AudioSource(sampleRate, 1, EXOTEL_LIVEKIT_INPUT_QUEUE_MS);
  const outputChunker = new ExotelPcmChunker(sampleRate);
  const outputTail: BridgeRuntime["outputTail"] = {};
  const readers = new Map<string, ReadableStreamDefaultReader<AudioFrame>>();
  const cancelTailFlush = () => {
    if (outputTail.timer) clearTimeout(outputTail.timer);
    outputTail.timer = undefined;
  };
  const sendAudioChunk = (chunk: Buffer) => sendJson(socket, {
    event: "media",
    stream_sid: streamSid,
    media: { payload: chunk.toString("base64") },
  });
  const flushAudioTail = () => {
    cancelTailFlush();
    const tail = outputChunker.flush();
    if (tail) sendAudioChunk(tail);
  };

  try {
    console.log(JSON.stringify({ event: "exotel-bridge-setup-stage", stage: "livekit_room_create", room: roomName }));
    await rooms.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 15, metadata });
    const attachAgentTrack = (track: RemoteTrack, participant: RemoteParticipant) => {
      if (participant.kind !== ParticipantKind.AGENT || track.kind !== TrackKind.KIND_AUDIO) return;
      const key = track.sid ?? randomUUID();
      if (readers.has(key)) return;
      const stream = new AudioStream(track, { sampleRate, numChannels: 1, frameSizeMs: 20 });
      const reader = stream.getReader();
      readers.set(key, reader);
      void (async () => {
        try {
          while (socket.readyState === WebSocket.OPEN) {
            const { done, value } = await reader.read();
            if (done) break;
            cancelTailFlush();
            for (const chunk of outputChunker.push(value.data)) {
              if (!sendAudioChunk(chunk)) return;
            }
            // RTC tracks stay subscribed between turns. A final partial packet
            // otherwise waits for the next reply or is lost on disconnect.
            if (outputChunker.pendingBytes) {
              outputTail.timer = setTimeout(flushAudioTail, 150);
            }
          }
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN) {
            console.error(JSON.stringify({
              event: "exotel-agent-audio-forward-failed",
              room: roomName,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        } finally {
          if (socket.readyState === WebSocket.OPEN) flushAudioTail();
          else cancelTailFlush();
          readers.delete(key);
          await reader.cancel().catch(() => undefined);
        }
      })();
    };
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      attachAgentTrack(track, participant);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      const key = track.sid ?? "";
      const reader = readers.get(key);
      if (reader) void reader.cancel().catch(() => undefined);
    });
    room.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
      if (
        participant?.kind !== ParticipantKind.AGENT
        || topic !== EXOTEL_PLAYBACK_CONTROL_TOPIC
        || !isExotelClearPlaybackMessage(data, topic)
      ) {
        return;
      }
      cancelTailFlush();
      outputChunker.clear();
      sendJson(socket, { event: "clear", stream_sid: streamSid });
      console.debug(JSON.stringify({
        event: "exotel-playback-cleared-after-confirmed-interruption",
        room: roomName,
      }));
    });

    const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
      identity: participantIdentity,
      name: fromPhone || "Exotel caller",
      metadata,
      ttl: "2h",
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    console.log(JSON.stringify({ event: "exotel-bridge-setup-stage", stage: "bridge_connect_and_dispatch", room: roomName }));
    const bridgeConnection = (async () => {
      await room.connect(env.livekitUrl, await token.toJwt());
      const inputTrack = LocalAudioTrack.createAudioTrack("exotel-caller-audio", audioSource);
      const publishOptions = new TrackPublishOptions();
      publishOptions.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant!.publishTrack(inputTrack, publishOptions);
    })();
    const agentDispatchPromise = dispatch.createDispatch(roomName, env.livekitAgentName, { metadata });
    const [, agentDispatch] = await Promise.all([bridgeConnection, agentDispatchPromise]);
    // Audio is ready at this point. Persisting dispatch identifiers must not
    // keep incoming Exotel media waiting behind a database round trip.
    void CallDetailRecordModel.updateOne(
      { _id: call._id },
      { $set: { livekitDispatchId: agentDispatch.id, livekitParticipantId: participantIdentity } },
    ).catch((error) => {
      console.error(JSON.stringify({
        event: "exotel-dispatch-metadata-update-failed",
        room: roomName,
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    return {
      agent,
      audioSource,
      callId: call.id,
      outputChunker,
      outputTail,
      participantIdentity,
      readers,
      room,
      roomName,
      rooms,
      sampleRate,
      streamSid,
    };
  } catch (error) {
    cancelTailFlush();
    await Promise.allSettled([
      room.disconnect(),
      rooms.deleteRoom(roomName),
      audioSource.close(),
      failCall(roomName, error, "exotel_bridge_setup_failed"),
    ]);
    throw error;
  }
}

async function closeBridgeRuntime(runtime: BridgeRuntime, endReason: string) {
  if (runtime.outputTail.timer) clearTimeout(runtime.outputTail.timer);
  runtime.outputTail.timer = undefined;
  const readers = [...runtime.readers.values()];
  runtime.readers.clear();
  runtime.outputChunker.clear();
  await Promise.allSettled([
    ...readers.map((reader) => reader.cancel()),
    runtime.audioSource.close(),
    runtime.room.disconnect(),
    runtime.rooms.deleteRoom(runtime.roomName),
    completeCall(runtime.roomName, endReason),
  ]);
}

function handleVoicebotSocket(socket: WebSocket) {
  let runtime: BridgeRuntime | null = null;
  let closing = false;
  let endReason = "exotel_stream_disconnected";
  let messageChain = Promise.resolve();
  const startTimer = setTimeout(() => socket.close(1008, "Start event timeout"), START_EVENT_TIMEOUT_MS);
  const durationTimer = setTimeout(() => {
    endReason = "exotel_maximum_duration";
    socket.close(1000, "Maximum stream duration reached");
  }, MAX_STREAM_DURATION_MS);

  const close = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(startTimer);
    clearTimeout(durationTimer);
    if (runtime) await closeBridgeRuntime(runtime, endReason);
  };

  const handleEvent = async (event: ExotelStreamEvent) => {
    if (closing) return;
    if (event.event === "connected") {
      console.log(JSON.stringify({ event: "exotel-voicebot-protocol-connected" }));
      return;
    }
    if (event.event === "mark") return;
    if (event.event === "start") {
      if (runtime) throw new Error("Exotel stream sent more than one start event.");
      // The start event arrived successfully. Do not let local LiveKit setup
      // race the protocol-start timeout on a cold deployment.
      clearTimeout(startTimer);
      runtime = await createBridgeRuntime(socket, event);
      // Socket closure can win while provider/room setup is still in flight.
      if (closing) {
        await closeBridgeRuntime(runtime, endReason);
        return;
      }
      console.log(JSON.stringify({
        event: "exotel-voicebot-connected",
        room: runtime.roomName,
        callId: runtime.callId,
        streamSid: runtime.streamSid,
        sampleRate: runtime.sampleRate,
      }));
      return;
    }
    if (!runtime) throw new Error(`Exotel ${event.event} event arrived before start.`);
    if (event.event === "media") {
      const payload = event.media?.payload;
      if (!payload) throw new Error("Exotel media event is missing its payload.");
      const samples = decodeExotelPcm(payload);
      await runtime.audioSource.captureFrame(
        new AudioFrame(samples, runtime.sampleRate, 1, samples.length),
      );
      return;
    }
    if (event.event === "dtmf") {
      const digit = String(event.dtmf?.digit ?? "");
      const code = dtmfCode(digit);
      if (code !== undefined) await runtime.room.localParticipant?.publishDtmf(code, digit);
      return;
    }
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, "Text JSON events are required");
      return;
    }
    if (closing) return;
    let event: ExotelStreamEvent;
    try {
      event = parseExotelStreamEvent(rawDataText(data));
    } catch {
      endReason = "exotel_stream_error";
      socket.close(1007, "Invalid stream event");
      void close().catch(console.error);
      return;
    }
    // A hang-up is control traffic; never queue it behind buffered media.
    if (event.event === "stop") {
      endReason = event.stop?.reason || "exotel_stream_stopped";
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Exotel stream stopped");
      void close().catch(console.error);
      return;
    }
    messageChain = messageChain
      .then(() => handleEvent(event))
      .catch((error) => {
        // Closing the audio source can reject the in-flight capture normally.
        if (closing) return;
        endReason = "exotel_stream_error";
        console.error(JSON.stringify({
          event: "exotel-voicebot-stream-error",
          room: runtime?.roomName ?? "",
          error: error instanceof Error ? error.message : String(error),
        }));
        if (runtime) void failCall(runtime.roomName, error, endReason).catch(console.error);
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Voicebot bridge error");
        void close().catch(console.error);
      });
  });
  socket.once("close", () => void close().catch(console.error));
  socket.once("error", (error) => {
    endReason = "exotel_websocket_error";
    console.error(JSON.stringify({ event: "exotel-voicebot-websocket-error", error: error.message }));
    void close().catch(console.error);
  });
}

export function attachExotelVoicebotServer(server: Server) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_STREAM_MESSAGE_BYTES });
  const activeSockets = new Set<WebSocket>();
  webSockets.on("connection", (socket, request) => {
    activeSockets.add(socket);
    console.log(JSON.stringify({
      event: "exotel-voicebot-websocket-open",
      remoteAddress: request.socket.remoteAddress ?? "",
      activeConnections: activeSockets.size,
    }));
    socket.once("close", () => activeSockets.delete(socket));
    handleVoicebotSocket(socket);
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const streamPath = env.exotelStreamPath.replace(/\/$/, "");
    if (url.pathname !== streamPath && !url.pathname.startsWith(`${streamPath}/`)) {
      writeUpgradeError(socket, 404, "Not Found");
      return;
    }
    if (!env.exotelStreamConfigured) {
      console.warn(JSON.stringify({ event: "exotel-voicebot-upgrade-rejected", reason: "not_configured" }));
      writeUpgradeError(socket, 503, "Exotel stream authentication is not configured");
      return;
    }
    if (!isAuthorizedExotelStream(request)) {
      console.warn(JSON.stringify({
        event: "exotel-voicebot-upgrade-rejected",
        reason: "unauthorized",
        queryKeys: [...url.searchParams.keys()],
        hasPathToken: url.pathname.length > streamPath.length + 1,
        hasAuthorizationHeader: Boolean(request.headers.authorization),
      }));
      writeUpgradeError(socket, 401, "Unauthorized");
      return;
    }
    if (activeSockets.size >= env.exotelStreamMaxConnections) {
      console.warn(JSON.stringify({ event: "exotel-voicebot-upgrade-rejected", reason: "capacity" }));
      writeUpgradeError(socket, 503, "Exotel stream capacity reached");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  };
  server.on("upgrade", onUpgrade);

  return {
    activeCount: () => activeSockets.size,
    close: async () => {
      server.off("upgrade", onUpgrade);
      for (const socket of activeSockets) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    },
  };
}
