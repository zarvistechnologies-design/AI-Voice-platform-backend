import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { getVobizCredentials } from "../src/services/integrationService.js";

type VobizCdr = {
  call_direction?: string;
  caller_id_number?: string;
  destination_number?: string;
  duration?: number;
  billsec?: number;
  ring_time?: number;
  answer_time?: string | null;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  hangup_cause?: string;
  hangup_cause_code?: number;
  hangup_cause_name?: string;
  hangup_disposition?: string;
  hangup_source?: string;
  failure_code?: string | null;
  failure_reason?: string | null;
  sip_user_agent?: string;
  codec?: string | null;
  context?: string;
  region?: string;
  trunk_id?: string | null;
  terminated_to?: string | null;
};

const ownerId = process.argv[2]?.trim();
const phoneNumber = process.argv[3]?.trim() ?? "";
if (!ownerId) throw new Error("Usage: tsx scripts/vobizCdrDiagnostic.ts <ownerId> [phone number]");

function mask(value: unknown) {
  const text = String(value ?? "");
  return text ? `***${text.slice(-4)}` : "";
}

await connectDatabase();

try {
  const credentials = await getVobizCredentials(ownerId);
  const response = await fetch(
    `${env.vobizBaseUrl.replace(/\/$/, "")}/v1/Account/${encodeURIComponent(credentials.authId)}/cdr/recent?limit=50`,
    {
      headers: {
        "X-Auth-ID": credentials.authId,
        "X-Auth-Token": credentials.authToken,
        Accept: "application/json",
      },
    },
  );
  const body = await response.json().catch(() => null) as { data?: VobizCdr[]; message?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `Vobiz CDR request failed with ${response.status}.`);
  }

  const calls = (body?.data ?? []).filter((call) => {
    if (!phoneNumber) return true;
    return call.caller_id_number === phoneNumber || call.destination_number === phoneNumber;
  });
  console.log(JSON.stringify(calls.slice(0, 20).map((call) => ({
    direction: call.call_direction,
    caller: mask(call.caller_id_number),
    destination: mask(call.destination_number),
    startedAt: call.start_time ?? call.created_at,
    endedAt: call.end_time,
    duration: call.duration,
    billsec: call.billsec,
    ringTime: call.ring_time,
    answeredAt: call.answer_time,
    hangup: call.hangup_cause,
    hangupCode: call.hangup_cause_code,
    hangupName: call.hangup_cause_name,
    disposition: call.hangup_disposition,
    hangupSource: call.hangup_source,
    failureCode: call.failure_code,
    failureReason: call.failure_reason,
    sipUserAgent: call.sip_user_agent,
    codec: call.codec,
    context: call.context,
    region: call.region,
    trunk: mask(call.trunk_id),
    terminatedTo: call.terminated_to,
  })), null, 2));
} finally {
  await mongoose.disconnect();
}
