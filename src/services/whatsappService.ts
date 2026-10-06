import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

const GRAPH_BASE_URL = "https://graph.facebook.com";

export type WhatsAppPhoneDetails = {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  codeVerificationStatus: string;
  qualityRating: string;
};

export type WhatsAppSendMessageOptions = {
  type?: "text" | "template";
  text?: string;
  template?: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
};

export function cleanPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // If user provides a 10-digit Indian number without country code, prepend 91
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

/**
 * Exchanges the authorization code received from Meta Embedded Signup for a permanent access token.
 */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  if (!code?.trim()) throw new HttpError(400, "Authorization code is required.");
  if (!env.metaAppSecret) {
    throw new HttpError(
      500,
      "META_APP_SECRET is not configured in the server environment. Please set it in .env.",
    );
  }

  const url = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/oauth/access_token`);
  url.searchParams.set("client_id", env.metaAppId);
  url.searchParams.set("client_secret", env.metaAppSecret);
  url.searchParams.set("code", code.trim());

  const response = await fetch(url.toString(), { method: "GET" });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok || !data.access_token) {
    const message = (data.error && typeof data.error === "object" && "message" in data.error)
      ? String((data.error as { message: unknown }).message)
      : "Failed to exchange authorization code with Meta.";
    throw new HttpError(response.status || 400, `Meta OAuth error: ${message}`);
  }

  return String(data.access_token);
}

/**
 * Inspects the token with Meta debug_token endpoint or /me/whatsapp_business_accounts
 * to automatically retrieve associated WhatsApp Business Account IDs.
 */
export async function getWabaIdsFromToken(accessToken: string): Promise<string[]> {
  const wabaIds: string[] = [];

  // 1. Inspect granular_scopes from debug_token
  try {
    const debugUrl = new URL(`${GRAPH_BASE_URL}/debug_token`);
    debugUrl.searchParams.set("input_token", accessToken);
    debugUrl.searchParams.set("access_token", `${env.metaAppId}|${env.metaAppSecret}`);

    const res = await fetch(debugUrl.toString());
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const tokenData = data.data as Record<string, unknown> | undefined;
    const granularScopes = Array.isArray(tokenData?.granular_scopes)
      ? (tokenData.granular_scopes as Array<Record<string, unknown>>)
      : [];

    for (const scope of granularScopes) {
      if (scope.scope === "whatsapp_business_management" && Array.isArray(scope.target_ids)) {
        for (const id of scope.target_ids) {
          if (typeof id === "string" && id.trim()) {
            wabaIds.push(id.trim());
          }
        }
      }
    }
  } catch (err) {
    console.warn("debug_token check failed, falling back to /me/whatsapp_business_accounts:", err);
  }

  if (wabaIds.length > 0) return wabaIds;

  // 2. Fallback: Query /me/whatsapp_business_accounts
  try {
    const url = `${GRAPH_BASE_URL}/${env.whatsappApiVersion}/me/whatsapp_business_accounts`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accounts = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
    for (const acc of accounts) {
      const id = String(acc.id ?? "").trim();
      if (id) wabaIds.push(id);
    }
  } catch (err) {
    console.warn("Could not retrieve accounts from /me/whatsapp_business_accounts:", err);
  }

  return wabaIds;
}

/**
 * Retrieves phone numbers associated with a WABA.
 */
export async function getWabaPhoneNumbers(
  wabaId: string,
  accessToken: string,
): Promise<Array<{ id: string; display_phone_number?: string; verified_name?: string }>> {
  try {
    const url = `${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${wabaId.trim()}/phone_numbers`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.data)) {
      return [];
    }
    return data.data
      .map((item: Record<string, unknown>) => ({
        id: String(item.id ?? ""),
        display_phone_number:
          typeof item.display_phone_number === "string" ? item.display_phone_number : undefined,
        verified_name: typeof item.verified_name === "string" ? item.verified_name : undefined,
      }))
      .filter((item: { id: string }) => Boolean(item.id));
  } catch {
    return [];
  }
}

/**
 * Subscribes the platform webhook to the client's WhatsApp Business Account (WABA).
 */
export async function subscribeWabaApp(wabaId: string, accessToken: string): Promise<boolean> {
  if (!wabaId?.trim()) throw new HttpError(400, "WABA ID is required.");

  const response = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${wabaId.trim()}/subscribed_apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = (data.error && typeof data.error === "object" && "message" in data.error)
      ? String((data.error as { message: unknown }).message)
      : "Failed to subscribe webhook to WABA.";
    throw new HttpError(response.status || 400, `Meta WABA subscription error: ${message}`);
  }

  return Boolean(data.success);
}

/**
 * Registers a phone number with WhatsApp Cloud API using a 6-digit PIN.
 */
export async function registerPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin = "123456",
): Promise<boolean> {
  if (!phoneNumberId?.trim()) throw new HttpError(400, "Phone number ID is required.");

  const response = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${phoneNumberId.trim()}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      pin,
    }),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = (data.error && typeof data.error === "object" && "message" in data.error)
      ? String((data.error as { message: unknown }).message)
      : "Failed to register WhatsApp phone number.";
    throw new HttpError(response.status || 400, `Meta phone registration error: ${message}`);
  }

  return Boolean(data.success);
}

/**
 * Retrieves phone details (display number, verified name, quality rating) from Meta.
 */
export async function getWhatsAppPhoneDetails(
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppPhoneDetails> {
  if (!phoneNumberId?.trim()) throw new HttpError(400, "Phone number ID is required.");

  const url = `${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${phoneNumberId.trim()}?fields=display_phone_number,verified_name,code_verification_status,quality_rating`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = (data.error && typeof data.error === "object" && "message" in data.error)
      ? String((data.error as { message: unknown }).message)
      : "Failed to fetch phone number details from Meta.";
    throw new HttpError(response.status || 400, message);
  }

  return {
    id: String(data.id ?? phoneNumberId),
    displayPhoneNumber: String(data.display_phone_number ?? ""),
    verifiedName: String(data.verified_name ?? ""),
    codeVerificationStatus: String(data.code_verification_status ?? "UNKNOWN"),
    qualityRating: String(data.quality_rating ?? "UNKNOWN"),
  };
}

/**
 * Sends a WhatsApp message (text or template) using Meta WhatsApp Cloud API.
 */
export async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  options: WhatsAppSendMessageOptions,
): Promise<{ messageId: string }> {
  const recipient = cleanPhoneNumber(to);
  if (!recipient || recipient.length < 10) {
    throw new HttpError(400, "Invalid recipient phone number.");
  }

  const type = options.type ?? "text";
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type,
  };

  if (type === "text") {
    payload.text = {
      preview_url: false,
      body: options.text || "Hello from Vozon AI Platform!",
    };
  } else if (type === "template" && options.template) {
    payload.template = options.template;
  }

  const response = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = (data.error && typeof data.error === "object" && "message" in data.error)
      ? String((data.error as { message: unknown }).message)
      : "Failed to send WhatsApp message.";
    throw new HttpError(response.status || 400, `WhatsApp Cloud API error: ${message}`);
  }

  const messages = Array.isArray(data.messages) ? (data.messages as Array<{ id?: string }>) : [];
  const messageId = String(messages[0]?.id ?? "");

  return { messageId };
}
