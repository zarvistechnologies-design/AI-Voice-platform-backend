export const EXOTEL_SUPPORTED_SAMPLE_RATES = new Set([8_000, 16_000, 24_000]);

export type ExotelConnectedEvent = { event: "connected" };
export type ExotelStartEvent = {
  event: "start";
  stream_sid?: string;
  start?: {
    stream_sid?: string;
    call_sid?: string;
    account_sid?: string;
    from?: string;
    to?: string;
    custom_parameters?: unknown;
    media_format?: {
      encoding?: string;
      sample_rate?: string | number;
      bit_rate?: string | number;
    };
  };
};
export type ExotelMediaEvent = {
  event: "media";
  stream_sid?: string;
  media?: { payload?: string };
};
export type ExotelDtmfEvent = {
  event: "dtmf";
  stream_sid?: string;
  dtmf?: { digit?: string; duration?: string | number };
};
export type ExotelMarkEvent = {
  event: "mark";
  stream_sid?: string;
  mark?: { name?: string };
};
export type ExotelStopEvent = {
  event: "stop";
  stream_sid?: string;
  stop?: { call_sid?: string; account_sid?: string; reason?: string };
};

export type ExotelStreamEvent =
  | ExotelConnectedEvent
  | ExotelStartEvent
  | ExotelMediaEvent
  | ExotelDtmfEvent
  | ExotelMarkEvent
  | ExotelStopEvent;

export function parseExotelStreamEvent(value: string): ExotelStreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Exotel sent invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Exotel sent an invalid stream event.");
  const event = (parsed as { event?: unknown }).event;
  if (!["connected", "start", "media", "dtmf", "mark", "stop"].includes(String(event))) {
    throw new Error(`Unsupported Exotel stream event: ${String(event || "missing")}.`);
  }
  return parsed as ExotelStreamEvent;
}

export function exotelSampleRate(event: ExotelStartEvent) {
  const value = Number(event.start?.media_format?.sample_rate ?? 8_000);
  if (!EXOTEL_SUPPORTED_SAMPLE_RATES.has(value)) {
    throw new Error(`Unsupported Exotel sample rate: ${value}.`);
  }
  return value;
}

function canonicalPhone(value: string) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export function exotelPhoneCandidates(value: unknown) {
  if (typeof value !== "string") return [];
  const canonical = canonicalPhone(value);
  const digits = value.replace(/\D/g, "");
  return [...new Set([value.trim(), canonical, digits ? `+${digits}` : ""].filter(Boolean))];
}

export function decodeExotelPcm(payload: string) {
  if (!payload) throw new Error("Exotel media payload is empty.");
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.byteLength % 2 !== 0) {
    throw new Error("Exotel media payload is not valid 16-bit PCM.");
  }
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2);
  }
  return samples;
}

export function encodeExotelPcm(samples: Int16Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(samples[index] ?? 0, index * 2);
  }
  return bytes;
}

export class ExotelPcmChunker {
  private pending = Buffer.alloc(0);
  readonly chunkBytes: number;

  constructor(sampleRate: number) {
    if (!EXOTEL_SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
      throw new Error(`Unsupported Exotel sample rate: ${sampleRate}.`);
    }
    // Exotel requires at least 100 ms/3,200 bytes and a multiple of 320 bytes.
    const bytesPer100Ms = Math.round((sampleRate * 2) / 10);
    this.chunkBytes = Math.ceil(Math.max(3_200, bytesPer100Ms) / 320) * 320;
  }

  push(samples: Int16Array) {
    this.pending = Buffer.concat([this.pending, encodeExotelPcm(samples)]);
    const chunks: Buffer[] = [];
    while (this.pending.byteLength >= this.chunkBytes) {
      chunks.push(this.pending.subarray(0, this.chunkBytes));
      this.pending = this.pending.subarray(this.chunkBytes);
    }
    return chunks;
  }

  clear() {
    this.pending = Buffer.alloc(0);
  }
}
