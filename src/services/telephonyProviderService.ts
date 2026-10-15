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

type PlivoIncomingNumber = {
  number?: string;
  alias?: string;
  carrier?: string;
  region?: string;
  voice_enabled?: boolean;
  sub_account?: string;
  application?: string;
};

async function providerJson<T>(provider: "Twilio" | "Exotel" | "Plivo", url: string, username: string, password: string) {
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
    return records.some((record) => {
      const recordDigits = record.phone_number?.replace(/\D/g, "") ?? "";
      if (!recordDigits) return false;
      if (recordDigits === importedDigits) return true;
      if (recordDigits.length >= 10 && importedDigits.length >= 10) {
        return recordDigits.slice(-10) === importedDigits.slice(-10);
      }
      return false;
    });
  });
  if (alreadyMapped) return;

  try {
    await exotelTrunkJson(input, path, {
      method: "POST",
      body: { phone_number: input.phoneNumber, mode: "pstn" },
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (message.includes("already") || message.includes("exist")) {
      return;
    }
    throw error;
  }
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

export async function ensureTwilioNumberRouting(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  apiRegion: "us1" | "au1" | "ie1";
  phoneNumber: string;
  phoneNumberSid: string;
  trunkSid?: string;
}): Promise<{ mode: "trunk" | "webhook"; trunkSid?: string; voiceUrl?: string }> {
  const trunkSid = input.trunkSid?.trim() || env.twilioSipTrunkSid;
  const host = input.apiRegion === "us1" ? "api.twilio.com" : `api.${input.apiRegion}.twilio.com`;
  const authHeader = `Basic ${Buffer.from(`${input.apiKeySid}:${input.apiKeySecret}`).toString("base64")}`;

  // 1. Try Elastic SIP Trunk mapping if a trunk SID is present
  if (trunkSid) {
    const trunkHost = input.apiRegion === "us1" ? "trunking.twilio.com" : `trunking.${input.apiRegion}.twilio.com`;
    const url = `https://${trunkHost}/v1/Trunks/${encodeURIComponent(trunkSid)}/PhoneNumbers`;
    const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: authHeader,
          Accept: "application/json",
        },
        body: new URLSearchParams({ PhoneNumberSid: input.phoneNumberSid }),
        signal,
      });

      if (response.ok) {
        return { mode: "trunk", trunkSid };
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const message = (body?.message || "").toLowerCase();
      if (response.status === 409 || message.includes("already") || message.includes("exist")) {
        return { mode: "trunk", trunkSid };
      }

      console.warn(`[Twilio] Trunk mapping to ${trunkSid} failed (${response.status}: ${body?.message || "error"}). Falling back to TwiML SIP forwarding.`);
    } catch (err) {
      console.warn(`[Twilio] Trunk mapping request failed: ${err instanceof Error ? err.message : String(err)}. Falling back to TwiML SIP forwarding.`);
    }
  }

  // 2. Configure VoiceUrl for TwiML SIP forwarding
  const webhookUrl = `${env.backendPublicUrl}/api/voice/telephony/twilio/voice-webhook`;
  const url = `https://${host}/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(input.phoneNumberSid)}.json`;
  const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: authHeader,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        VoiceUrl: webhookUrl,
        VoiceMethod: "POST",
      }),
      signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      console.warn(`[Twilio] VoiceUrl update returned status ${response.status}: ${body?.message || "unknown"}`);
    }
  } catch (err) {
    console.warn(`[Twilio] Failed to update VoiceUrl on Twilio: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { mode: "webhook", voiceUrl: webhookUrl };
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
  const inputDigits = input.phoneNumber.replace(/\D/g, "");
  const number = body.incoming_phone_numbers?.find((item) => {
    if (!item.phone_number) return false;
    if (item.phone_number === input.phoneNumber) return true;
    const itemDigits = item.phone_number.replace(/\D/g, "");
    if (itemDigits === inputDigits) return true;
    if (inputDigits.length >= 10 && itemDigits.length >= 10) {
      return itemDigits.slice(-10) === inputDigits.slice(-10);
    }
    return false;
  });
  if (!number) throw new HttpError(404, "That number was not found in this Exotel account.");
  if (number.capabilities?.voice === false) throw new HttpError(409, "This Exotel number is not voice capable.");
  return {
    id: number.sid ?? input.phoneNumber,
    e164: number.phone_number ?? input.phoneNumber,
    label: number.friendly_name ?? "Exotel number",
    region: [number.region, number.country].filter(Boolean).join(", ") || `Exotel ${input.dataCenter}`,
  };
}

export async function verifyPlivoNumber(input: {
  authId: string;
  authToken: string;
  phoneNumber: string;
}): Promise<VerifiedProviderNumber> {
  const authId = input.authId.trim();
  const authToken = input.authToken.trim();
  if (!authId) throw new HttpError(400, "Enter the Plivo Auth ID.");
  if (!authToken) throw new HttpError(400, "Enter the Plivo Auth Token.");

  const digits = input.phoneNumber.replace(/\D/g, "");
  let number: PlivoIncomingNumber | null = null;

  try {
    const directUrl = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Number/${encodeURIComponent(digits)}/`;
    number = await providerJson<PlivoIncomingNumber>("Plivo", directUrl, authId, authToken);
  } catch (directError) {
    if (directError instanceof HttpError && directError.statusCode === 404) {
      try {
        const queryUrl = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Number/?number=${encodeURIComponent(digits)}`;
        const listBody = await providerJson<{ objects?: PlivoIncomingNumber[] }>("Plivo", queryUrl, authId, authToken);
        number = listBody.objects?.find((item) => item.number?.replace(/\D/g, "") === digits) ?? null;
      } catch {
        try {
          const pnUrl = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/PhoneNumber/${encodeURIComponent(digits)}/`;
          number = await providerJson<PlivoIncomingNumber>("Plivo", pnUrl, authId, authToken);
        } catch {
          throw directError;
        }
      }
    } else {
      throw directError;
    }
  }

  if (!number || !number.number) {
    throw new HttpError(404, "That number was not found in this Plivo account.");
  }
  if (number.voice_enabled === false) {
    throw new HttpError(409, "This Plivo number is not voice capable.");
  }

  const canonicalE164 = input.phoneNumber.startsWith("+") ? input.phoneNumber : `+${digits}`;
  return {
    id: number.number,
    e164: canonicalE164,
    label: number.alias?.trim() || "Plivo number",
    region: number.region?.trim() || "Plivo",
  };
}

export async function ensurePlivoNumberRouting(input: {
  authId: string;
  authToken: string;
  phoneNumber: string;
  trunkId?: string;
}): Promise<{ mode: "trunk" | "webhook"; trunkId?: string; voiceUrl?: string }> {
  const authId = input.authId.trim();
  const authToken = input.authToken.trim();
  const digits = input.phoneNumber.replace(/\D/g, "");
  const trunkId = input.trunkId?.trim() || env.plivoSipInboundTrunkId;
  const authHeader = `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`;

  // 1. If an Inbound Zentrunk trunk ID is configured or provided, map the number to it
  if (trunkId) {
    const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
    try {
      const response = await fetch(
        `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Number/${encodeURIComponent(digits)}/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
            Accept: "application/json",
          },
          body: JSON.stringify({ app_id: trunkId }),
          signal,
        },
      );

      if (response.ok) {
        return { mode: "trunk", trunkId };
      }

      const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      console.warn(
        `[Plivo] Trunk mapping to ${trunkId} failed (${response.status}: ${body?.message || body?.error || "error"}). Falling back to XML SIP forwarding.`,
      );
    } catch (err) {
      console.warn(
        `[Plivo] Trunk mapping request failed: ${err instanceof Error ? err.message : String(err)}. Falling back to XML SIP forwarding.`,
      );
    }
  }

  // 2. Configure Voice Webhook for Plivo XML SIP forwarding as alternative/fallback
  const webhookUrl = `${env.backendPublicUrl}/api/voice/telephony/plivo/voice-webhook`;
  const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  try {
    const appResponse = await fetch(
      `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Application/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          Accept: "application/json",
        },
        body: JSON.stringify({
          app_name: `Vozon SIP Bridge (${digits.slice(-4)})`,
          answer_url: webhookUrl,
          answer_method: "POST",
        }),
        signal,
      },
    );

    if (appResponse.ok) {
      const appBody = (await appResponse.json().catch(() => null)) as { app_id?: string } | null;
      if (appBody?.app_id) {
        await fetch(
          `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Number/${encodeURIComponent(digits)}/`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader,
              Accept: "application/json",
            },
            body: JSON.stringify({ app_id: appBody.app_id }),
            signal: AbortSignal.timeout(env.telephonyProviderTimeoutMs),
          },
        ).catch(() => null);
      }
    }
  } catch (err) {
    console.warn(`[Plivo] Failed to configure XML voice webhook: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { mode: "webhook", voiceUrl: webhookUrl };
}

