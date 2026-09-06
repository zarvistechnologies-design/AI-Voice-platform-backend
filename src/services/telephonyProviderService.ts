import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

type VerifiedProviderNumber = {
  id: string;
  e164: string;
  label: string;
  region: string;
};

type TwilioIncomingNumber = {
  sid?: string;
  phone_number?: string;
  friendly_name?: string;
  capabilities?: { voice?: boolean };
};

type ExotelIncomingNumber = {
  sid?: string;
  phone_number?: string;
  friendly_name?: string;
  country?: string;
  region?: string;
  capabilities?: { voice?: boolean };
};

async function providerJson<T>(provider: "Twilio" | "Exotel", url: string, username: string, password: string) {
  let response: globalThis.Response;
  let body: Record<string, unknown> | null = null;
  const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      signal,
    });
    body = await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return null;
    }) as Record<string, unknown> | null;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new HttpError(504, `${provider} verification timed out. Please try again.`);
    }
    throw new HttpError(502, `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const providerMessage = typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : "Check the credentials and account region.";
    throw new HttpError(400, `${provider} verification failed: ${providerMessage}`);
  }
  if (!body) throw new HttpError(502, `${provider} returned an empty response.`);
  return body as T;
}

type ExotelTrunkApiItem = {
  status?: string;
  data?: {
    id?: string | number;
    phone_number?: string;
  } | Array<{
    id?: string | number;
    phone_number?: string;
  }>;
  error?: string | { message?: string };
  message?: string;
};

type ExotelTrunkApiBody = {
  response?: ExotelTrunkApiItem | ExotelTrunkApiItem[];
  message?: string;
  error?: string | { message?: string };
};

function exotelApiItems(body: ExotelTrunkApiBody | null) {
  if (!body?.response) return [];
  return Array.isArray(body.response) ? body.response : [body.response];
}

function exotelApiMessage(body: ExotelTrunkApiBody | null) {
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error.message === "string") return body.error.message;
  const failed = exotelApiItems(body).find(
    (item) => item.status && item.status.toLowerCase() !== "success",
  );
  if (typeof failed?.message === "string") return failed.message;
  if (typeof failed?.error === "string") return failed.error;
  if (failed?.error && typeof failed.error.message === "string") return failed.error.message;
  return "Check the trunk SID, Exotel credentials, and number mapping.";
}

async function exotelTrunkJson(
  input: {
    accountSid: string;
    apiKey: string;
    apiToken: string;
    dataCenter: "mumbai" | "singapore";
  },
  path: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  const host = input.dataCenter === "mumbai" ? "api.in.exotel.com" : "api.exotel.com";
  const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  let response: globalThis.Response;
  let body: ExotelTrunkApiBody | null = null;
  try {
    response = await fetch(
      `https://${host}/v2/accounts/${encodeURIComponent(input.accountSid)}${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${input.apiKey}:${input.apiToken}`).toString("base64")}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal,
      },
    );
    body = await response.json().catch(() => null) as ExotelTrunkApiBody | null;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new HttpError(504, "Exotel trunk mapping timed out. Please try again.");
    }
    throw new HttpError(502, `Exotel trunk mapping could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new HttpError(400, `Exotel trunk mapping failed: ${exotelApiMessage(body)}`);
  }
  if (!body) throw new HttpError(502, "Exotel trunk mapping returned an empty response.");
  const failed = exotelApiItems(body).find(
    (item) => item.status && item.status.toLowerCase() !== "success",
  );
  if (failed) {
    throw new HttpError(400, `Exotel trunk mapping failed: ${exotelApiMessage(body)}`);
  }
  return body;
}

export async function ensureExotelNumberMappedToTrunk(input: {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  dataCenter: "mumbai" | "singapore";
  phoneNumber: string;
}) {
  const trunkSid = env.exotelSipTrunkSid;
  if (!trunkSid) {
    throw new HttpError(
      503,
      "Exotel SIP trunk mapping is not configured. Set EXOTEL_SIP_TRUNK_SID after creating the Exotrunk.",
    );
  }

  const path = `/trunks/${encodeURIComponent(trunkSid)}/phone-numbers`;
  const existing = await exotelTrunkJson(input, path);
  const importedDigits = input.phoneNumber.replace(/\D/g, "");
  const alreadyMapped = exotelApiItems(existing).some((item) => {
    const records = Array.isArray(item.data) ? item.data : item.data ? [item.data] : [];
    return records.some(
      (record) => record.phone_number?.replace(/\D/g, "") === importedDigits,
    );
  });
  if (alreadyMapped) return;

  await exotelTrunkJson(input, path, {
    method: "POST",
    body: { phone_number: input.phoneNumber, mode: "pstn" },
  });
}

export async function verifyTwilioNumber(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  apiRegion: "us1" | "au1" | "ie1";
  phoneNumber: string;
}): Promise<VerifiedProviderNumber> {
  if (!/^AC[0-9a-fA-F]{32}$/.test(input.accountSid)) {
    throw new HttpError(400, "Enter a valid Twilio Account SID beginning with AC.");
  }
  if (!/^SK[0-9a-fA-F]{32}$/.test(input.apiKeySid)) {
    throw new HttpError(400, "Enter a valid Twilio API Key SID beginning with SK.");
  }
  if (!input.apiKeySecret) throw new HttpError(400, "Enter the Twilio API Key Secret.");

  const host = input.apiRegion === "us1" ? "api.twilio.com" : `api.${input.apiRegion}.twilio.com`;
  const query = new URLSearchParams({ PhoneNumber: input.phoneNumber, PageSize: "20" });
  const body = await providerJson<{ incoming_phone_numbers?: TwilioIncomingNumber[] }>(
    "Twilio",
    `https://${host}/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/IncomingPhoneNumbers.json?${query}`,
    input.apiKeySid,
    input.apiKeySecret,
  );
  const number = body.incoming_phone_numbers?.find((item) => item.phone_number === input.phoneNumber);
  if (!number) throw new HttpError(404, "That number was not found in this Twilio account.");
  if (number.capabilities?.voice === false) throw new HttpError(409, "This Twilio number is not voice capable.");
  return {
    id: number.sid ?? input.phoneNumber,
    e164: number.phone_number ?? input.phoneNumber,
    label: number.friendly_name ?? "Twilio number",
    region: `Twilio ${input.apiRegion.toUpperCase()}`,
  };
}

export async function verifyExotelNumber(input: {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  dataCenter: "mumbai" | "singapore";
  phoneNumber: string;
}): Promise<VerifiedProviderNumber> {
  if (!input.accountSid) throw new HttpError(400, "Enter the Exotel Account SID.");
  if (!input.apiKey) throw new HttpError(400, "Enter the Exotel API Key.");
  if (!input.apiToken) throw new HttpError(400, "Enter the Exotel API Token.");

  const host = input.dataCenter === "mumbai" ? "api.in.exotel.com" : "api.exotel.com";
  const body = await providerJson<{ incoming_phone_numbers?: ExotelIncomingNumber[] }>(
    "Exotel",
    `https://${host}/v2_beta/Accounts/${encodeURIComponent(input.accountSid)}/IncomingPhoneNumbers`,
    input.apiKey,
    input.apiToken,
  );
  const number = body.incoming_phone_numbers?.find((item) => item.phone_number === input.phoneNumber);
  if (!number) throw new HttpError(404, "That number was not found in this Exotel account.");
  if (number.capabilities?.voice === false) throw new HttpError(409, "This Exotel number is not voice capable.");
  return {
    id: number.sid ?? input.phoneNumber,
    e164: number.phone_number ?? input.phoneNumber,
    label: number.friendly_name ?? "Exotel number",
    region: [number.region, number.country].filter(Boolean).join(", ") || `Exotel ${input.dataCenter}`,
  };
}
