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
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new HttpError(502, `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
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
