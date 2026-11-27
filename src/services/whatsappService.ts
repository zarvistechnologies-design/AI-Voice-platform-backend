import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

const GRAPH_BASE_URL = "https://graph.facebook.com";
let appWebhookSubscriptionCheck: { checkedAt: number; subscribed: boolean } | null = null;

/** Reads the WhatsApp messages subscription configured in the Meta App Dashboard. */
export async function checkWhatsAppAppWebhookSubscription(forceRefresh = false): Promise<boolean> {
  if (!env.metaAppId || !env.metaAppSecret) return false;
  if (!forceRefresh && appWebhookSubscriptionCheck && Date.now() - appWebhookSubscriptionCheck.checkedAt < 60_000) {
    return appWebhookSubscriptionCheck.subscribed;
  }

  let subscribed = false;
  try {
    const url = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${encodeURIComponent(env.metaAppId)}/subscriptions`);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.metaAppId}|${env.metaAppSecret}` },
    });
    const data = (await response.json().catch(() => ({}))) as {
      data?: Array<{
        object?: string;
        active?: boolean;
        callback_url?: string;
        fields?: Array<string | { name?: string; active?: boolean }>;
      }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(data.error?.message || `Meta returned HTTP ${response.status} while checking the messages webhook.`);
    }
    const expectedCallbackUrl = `${env.backendPublicUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`;
    const whatsappSubscription = data.data?.find((item) => item.object === "whatsapp_business_account");
    const hasMessagesField = whatsappSubscription?.fields?.some((field) =>
      (typeof field === "string" ? field : field.name) === "messages" && (typeof field === "string" || field.active !== false),
    );
    const callbackUrl = whatsappSubscription?.callback_url?.replace(/\/$/, "");
    subscribed = whatsappSubscription?.active === true && Boolean(hasMessagesField) && callbackUrl === expectedCallbackUrl;
    if (!subscribed) console.warn("WhatsApp messages webhook is not active in the Meta App Dashboard.");
  } catch (error) {
    console.warn("Could not check the Meta WhatsApp messages webhook:", error instanceof Error ? error.message : error);
  }

  appWebhookSubscriptionCheck = { checkedAt: Date.now(), subscribed };
  return subscribed;
}

export type WhatsAppPhoneDetails = {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  codeVerificationStatus: string;
  qualityRating: string;
};

export type MetaBusinessPortfolio = {
  id: string;
  name: string;
};

export type WhatsAppSendMessageOptions = {
  type?: "text" | "template" | "interactive" | "image" | "document";
  text?: string;
  image?: { link: string; caption?: string };
  document?: { link: string; caption?: string; filename?: string };
  template?: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
  interactive?: {
    type: "button";
    body: { text: string };
    action: {
      buttons: Array<{
        type: "reply";
        reply: { id: string; title: string };
      }>;
    };
  };
};

export type WhatsAppTemplate = {
  id?: string;
  name: string;
  category?: string;
  language: string;
  status: string;
  components: Array<{ type?: string; text?: string; format?: string; buttons?: unknown[] }>;
};

export async function listWabaTemplates(wabaId: string, accessToken: string): Promise<WhatsAppTemplate[]> {
  if (!/^\d{5,30}$/.test(wabaId)) throw new HttpError(400, "Connected WhatsApp Business Account ID is invalid.");
  const url = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${wabaId}/message_templates`);
  url.searchParams.set("fields", "id,name,category,language,status,components");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: WhatsAppTemplate[]; error?: { message?: string } };
  if (!response.ok) {
    throw new HttpError(response.status || 502, body.error?.message || "Could not fetch WhatsApp templates from Meta.");
  }
  return Array.isArray(body.data) ? body.data : [];
}

export async function createWabaTemplate(
  wabaId: string,
  accessToken: string,
  input: {
    name: string;
    category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
    language: string;
    headerType?: string;
    headerText?: string;
    headerMediaHandle?: string;
    bodyText: string;
    footerText?: string;
    buttons?: Array<{ type: string; text: string; value?: string }>;
  },
): Promise<{ id: string; status: string }> {
  if (!/^\d{5,30}$/.test(wabaId)) throw new HttpError(400, "Connected WhatsApp Business Account ID is invalid.");
  const components: Array<Record<string, unknown>> = [];
  if (input.headerType === "TEXT" && input.headerText?.trim()) {
    components.push({ type: "HEADER", format: "TEXT", text: input.headerText.trim() });
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(String(input.headerType))) {
    if (!input.headerMediaHandle) throw new HttpError(400, "Upload a sample header file before submitting this media template.");
    components.push({
      type: "HEADER",
      format: input.headerType,
      example: { header_handle: [input.headerMediaHandle] },
    });
  }
  components.push({ type: "BODY", text: input.bodyText });
  if (input.footerText?.trim()) {
    components.push({ type: "FOOTER", text: input.footerText.trim() });
  }
  if (Array.isArray(input.buttons) && input.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.slice(0, 3).map((b) =>
        b.type === "URL"
          ? { type: "URL", text: b.text.slice(0, 25), url: b.value || "https://example.com" }
          : b.type === "PHONE_NUMBER"
            ? { type: "PHONE_NUMBER", text: b.text.slice(0, 25), phone_number: b.value || "+919000000000" }
            : { type: "QUICK_REPLY", text: b.text.slice(0, 25) },
      ),
    });
  }

  const response = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${wabaId}/message_templates`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      category: input.category || "UTILITY",
      language: input.language || "en_US",
      components,
    }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new HttpError(response.status || 400, data.error?.message || "Meta rejected the WhatsApp template submission.");
  }
  return {
    id: String(data.id ?? ""),
    status: String(data.status ?? "PENDING").toUpperCase(),
  };
}

export async function uploadWhatsAppTemplateHeaderSample(
  accessToken: string,
  file: { buffer: Buffer; mimetype: string; size: number },
): Promise<string> {
  if (!env.metaAppId) throw new HttpError(503, "META_APP_ID is required to upload a WhatsApp template sample.");
  const supported: Record<string, { type: string; maxBytes: number }> = {
    "image/jpeg": { type: "IMAGE", maxBytes: 5 * 1024 * 1024 },
    "image/png": { type: "IMAGE", maxBytes: 5 * 1024 * 1024 },
    "video/mp4": { type: "VIDEO", maxBytes: 16 * 1024 * 1024 },
    "application/pdf": { type: "DOCUMENT", maxBytes: 100 * 1024 * 1024 },
  };
  const config = supported[file.mimetype];
  if (!config) throw new HttpError(400, "Choose a JPG, PNG, MP4, or PDF sample file.");
  if (!file.size || file.size > config.maxBytes) throw new HttpError(400, `The selected ${config.type.toLowerCase()} sample exceeds Meta's size limit.`);

  const initUrl = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${encodeURIComponent(env.metaAppId)}/uploads`);
  initUrl.searchParams.set("file_length", String(file.size));
  initUrl.searchParams.set("file_type", file.mimetype);
  initUrl.searchParams.set("access_token", accessToken);
  const initResponse = await fetch(initUrl, { method: "POST", signal: AbortSignal.timeout(20_000) });
  const initData = (await initResponse.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!initResponse.ok || !initData.id) throw new HttpError(initResponse.status || 502, initData.error?.message || "Meta could not start the media upload.");

  const uploadResponse = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${encodeURIComponent(initData.id)}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      "file_offset": "0",
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }),
    signal: AbortSignal.timeout(30_000),
  });
  const uploadData = (await uploadResponse.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
  if (!uploadResponse.ok || !uploadData.h) throw new HttpError(uploadResponse.status || 502, uploadData.error?.message || "Meta could not upload the template sample.");
  return uploadData.h;
}

export async function getWhatsAppTemplate(wabaId: string, accessToken: string, name: string, language: string): Promise<WhatsAppTemplate | null> {
  if (!/^\d{5,30}$/.test(wabaId)) throw new HttpError(400, "Connected WhatsApp Business Account ID is invalid.");
  const url = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${wabaId}/message_templates`);
  url.searchParams.set("name", name);
  url.searchParams.set("fields", "name,language,status,components");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(502, "Could not verify the WhatsApp template with Meta.");
  const body = await response.json() as { data?: WhatsAppTemplate[] };
  return Array.isArray(body.data)
    ? body.data.find((item) => item.name === name && item.language === language) ?? null
    : null;
}

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
  if (!env.metaAppId || !env.metaAppSecret) {
    throw new HttpError(
      500,
      "META_APP_ID and META_APP_SECRET must be configured for WhatsApp Embedded Signup.",
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
 * Lists the business portfolios the connected Meta user has authorized for Vozon.
 * This uses the business_management permission and is used to match the portfolio
 * selected in Embedded Signup to the WhatsApp account being connected.
 */
export async function getBusinessPortfolios(accessToken: string): Promise<MetaBusinessPortfolio[]> {
  if (!accessToken?.trim()) return [];

  const url = new URL(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/me/businesses`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("limit", "100");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken.trim()}` },
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok || !Array.isArray(data.data)) {
    const message = data.error && typeof data.error === "object" && "message" in data.error
      ? String((data.error as { message: unknown }).message)
      : "Could not list the Meta business portfolios available to this user.";
    throw new HttpError(response.status || 400, `Meta business portfolio lookup error: ${message}`);
  }

  return data.data
    .map((item: Record<string, unknown>) => ({
      id: String(item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
    }))
    .filter((portfolio: MetaBusinessPortfolio) => Boolean(portfolio.id));
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
  } else if (type === "interactive" && options.interactive) {
    payload.interactive = options.interactive;
  } else if (type === "image" && options.image) {
    payload.image = options.image;
  } else if (type === "document" && options.document) {
    payload.document = options.document;
  }

  const response = await fetch(`${GRAPH_BASE_URL}/${env.whatsappApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
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
  if (!messageId) throw new HttpError(502, "WhatsApp did not return a message ID. Check the provider before retrying.");

  return { messageId };
}
