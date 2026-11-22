import { HttpError } from "../utils/httpError.js";

export type AtlassianProvider = "atlassian" | "jira";
export type AtlassianCredentials = { site: string; email: string; token: string };

export function isAtlassianProvider(value: string): value is AtlassianProvider {
  return value === "atlassian" || value === "jira";
}

export function atlassianSite(value: unknown) {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  const host = /^[a-z0-9][a-z0-9-]*$/.test(input) ? `${input}.atlassian.net` : /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(input) ? input : (() => {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
      return url.hostname;
    } catch {
      return "";
    }
  })();
  if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(host)) {
    throw new HttpError(400, "Enter your Atlassian site, for example acme.atlassian.net.");
  }
  return `https://${host}`;
}

function credentials(value: AtlassianCredentials) {
  const site = atlassianSite(value?.site);
  const email = typeof value?.email === "string" ? value.email.trim() : "";
  const token = typeof value?.token === "string" ? value.token.trim() : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || !token || token.length > 2048) {
    throw new HttpError(400, "Enter your Atlassian account email and API token.");
  }
  return { site, email, token };
}

async function atlassianJson(url: string, value: AtlassianCredentials) {
  const verified = credentials(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${verified.email}:${verified.token}`).toString("base64")}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status === 401 || response.status === 403) throw new HttpError(400, "Atlassian rejected the email, token, or site permissions.");
    if (!response.ok) throw new HttpError(502, `Atlassian returned HTTP ${response.status}.`);
    if (!data || typeof data !== "object") throw new HttpError(502, "Atlassian returned an invalid response.");
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not reach the Atlassian site.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyAtlassianProvider(provider: AtlassianProvider, value: AtlassianCredentials) {
  const { site, email } = credentials(value);
  const path = provider === "jira" ? "/rest/api/3/myself" : "/wiki/rest/api/user/current";
  const result = await atlassianJson(`${site}${path}`, value);
  if (!result.accountId) throw new HttpError(502, "Atlassian returned an invalid account response.");
  return { accountId: String(result.displayName || email), site };
}

export async function previewAtlassianProvider(provider: AtlassianProvider, value: AtlassianCredentials) {
  const { site } = credentials(value);
  const path = provider === "jira"
    ? "/rest/api/3/project/search?maxResults=5"
    : "/wiki/api/v2/pages?limit=5";
  const result = await atlassianJson(`${site}${path}`, value);
  const entries = provider === "jira" ? result.values : result.results;
  return {
    items: Array.isArray(entries) ? entries.map((entry: Record<string, unknown>) => ({
      id: String(entry.id ?? ""),
      name: String(entry.name ?? entry.title ?? "Untitled"),
      type: provider === "jira" ? "project" : "page",
    })) : [],
  };
}
