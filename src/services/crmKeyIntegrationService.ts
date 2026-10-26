import { HttpError } from "../utils/httpError.js";

export type FreshsalesCredentials = { site: string; apiKey: string };
export type HighLevelCredentials = { locationId: string; token: string };

export function freshsalesSite(value: unknown) {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  const host = /^[a-z0-9][a-z0-9-]*$/.test(input) ? `${input}.myfreshworks.com` : /^(?:[a-z0-9][a-z0-9-]*\.)+(?:myfreshworks|freshworks)\.com$/.test(input) ? input : (() => {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
      return url.hostname;
    } catch {
      return "";
    }
  })();
  if (!/^(?:[a-z0-9][a-z0-9-]*\.)+(?:myfreshworks|freshworks)\.com$/.test(host)) {
    throw new HttpError(400, "Enter your Freshsales site, for example acme.myfreshworks.com.");
  }
  return `https://${host}`;
}

function freshsalesCredentials(value: FreshsalesCredentials) {
  const site = freshsalesSite(value?.site);
  const apiKey = typeof value?.apiKey === "string" ? value.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 2048) throw new HttpError(400, "Enter a valid Freshsales API key.");
  return { site, apiKey };
}

async function safeJson(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status === 401 || response.status === 403) throw new HttpError(400, "The provider rejected this API key or its permissions.");
    if (response.status === 429) throw new HttpError(429, "The provider rate limit was reached. Try again later.");
    if (!response.ok) throw new HttpError(502, `The provider returned HTTP ${response.status}.`);
    if (!data || typeof data !== "object" || data.error === true) throw new HttpError(502, "The provider returned an invalid response.");
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not reach the provider. Try again later.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function freshsalesFilters(value: FreshsalesCredentials) {
  const { site, apiKey } = freshsalesCredentials(value);
  const result = await safeJson(`${site}/crm/sales/api/contacts/filters`, {
    headers: { Authorization: `Token token=${apiKey}`, "Content-Type": "application/json" },
  });
  if (!Array.isArray(result.filters)) throw new HttpError(502, "Freshsales returned an invalid contacts response.");
  return { site, items: result.filters.slice(0, 5).map((entry: Record<string, unknown>) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "Contact view"), type: "contact view" })) };
}

function highLevelCredentials(value: HighLevelCredentials) {
  const locationId = typeof value?.locationId === "string" ? value.locationId.trim() : "";
  const token = typeof value?.token === "string" ? value.token.trim() : "";
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(locationId)) {
    throw new HttpError(400, "Enter a valid HighLevel Location ID.");
  }
  if (!token || token.length > 4096) {
    throw new HttpError(400, "Enter a valid HighLevel Private Integration Token.");
  }
  return { locationId, token };
}

function highLevelHeaders(token: string) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
  };
}

export async function highLevelLocation(value: HighLevelCredentials) {
  const { locationId, token } = highLevelCredentials(value);
  const result = await safeJson(
    `https://services.leadconnectorhq.com/locations/${encodeURIComponent(locationId)}`,
    { headers: highLevelHeaders(token) },
  );
  const location = result.location as Record<string, unknown> | undefined;
  if (!location || String(location.id ?? "") !== locationId) {
    throw new HttpError(502, "HighLevel returned an invalid location response.");
  }
  return { locationId, name: String(location.name || location.companyId || "HighLevel location") };
}

export async function highLevelContacts(value: HighLevelCredentials) {
  const { locationId, token } = highLevelCredentials(value);
  const url = new URL("https://services.leadconnectorhq.com/contacts/");
  url.searchParams.set("locationId", locationId);
  url.searchParams.set("limit", "5");
  const result = await safeJson(url.toString(), { headers: highLevelHeaders(token) });
  if (!Array.isArray(result.contacts)) {
    throw new HttpError(502, "HighLevel returned an invalid contacts response.");
  }
  return {
    items: result.contacts.slice(0, 5).map((entry: Record<string, unknown>) => ({
      id: String(entry.id ?? ""),
      name: String(entry.name || [entry.firstName, entry.lastName].filter(Boolean).join(" ") || entry.email || entry.phone || "HighLevel contact"),
      type: "contact",
    })),
  };
}
