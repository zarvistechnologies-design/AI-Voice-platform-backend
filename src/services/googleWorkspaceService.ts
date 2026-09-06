import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client, type Credentials } from "google-auth-library";

import { env } from "../config/env.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "./dashboardCacheService.js";
import { productNameForOrganization } from "./whiteLabelService.js";

const scopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

type GoogleState = { orgId: string; nonce: string };

function oauthClient() {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new HttpError(503, "Google Workspace is not configured by the platform administrator.");
  }
  return new OAuth2Client(env.googleClientId, env.googleClientSecret, env.googleOAuthRedirectUri);
}

function stateFor(orgId: string) {
  return jwt.sign({ orgId, nonce: randomBytes(16).toString("hex") }, env.jwtSecret, {
    expiresIn: "10m",
    audience: "google-workspace-oauth",
  });
}

function parseState(state: string) {
  try {
    return jwt.verify(state, env.jwtSecret, { audience: "google-workspace-oauth" }) as GoogleState;
  } catch {
    throw new HttpError(400, "Google authorization expired or is invalid. Start the connection again.");
  }
}

async function googleJson<T>(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await response.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = data as { error?: { message?: string }; message?: string };
    throw new HttpError(response.status === 401 ? 409 : 400, error.error?.message ?? error.message ?? "Google request failed.");
  }
  return data as T;
}

async function storedGoogle(orgId: string) {
  const integration = await ProviderIntegrationModel.findOne({ ownerId: orgId, provider: "google" }).select("+secretEncrypted");
  if (!integration) throw new HttpError(409, "Connect Google Workspace before using this integration.");
  let credentials: Credentials;
  try {
    credentials = JSON.parse(decryptSecret(integration.secretEncrypted)) as Credentials;
  } catch {
    throw new HttpError(409, "The saved Google connection is invalid. Disconnect and reconnect Google.");
  }
  return { integration, credentials };
}

async function accessToken(orgId: string) {
  const { integration, credentials } = await storedGoogle(orgId);
  const client = oauthClient();
  client.setCredentials(credentials);
  try {
    const result = await client.getAccessToken();
    if (!result.token) throw new Error("Google did not return an access token.");
    const latest = client.credentials;
    if (latest.access_token !== credentials.access_token || latest.expiry_date !== credentials.expiry_date) {
      integration.secretEncrypted = encryptSecret(JSON.stringify({ ...credentials, ...latest }));
      integration.lastVerifiedAt = new Date();
      await integration.save();
    }
    return result.token;
  } catch {
    integration.status = "error";
    await integration.save();
    throw new HttpError(409, "Google authorization has expired. Reconnect the Google account.");
  }
}

export function googleAuthorizationUrl(orgId: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: scopes,
    state: stateFor(orgId),
  });
}

export async function completeGoogleAuthorization(expectedOrgId: string, code: string, rawState: string) {
  const state = parseState(rawState);
  if (state.orgId !== expectedOrgId) throw new HttpError(403, "Google connection belongs to another workspace.");
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const ticket = tokens.id_token ? await client.verifyIdToken({ idToken: tokens.id_token, audience: env.googleClientId }) : null;
  const email = String(ticket?.getPayload()?.email ?? "Google Workspace");
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId: expectedOrgId, provider: "google" },
    {
      ownerId: expectedOrgId,
      provider: "google",
      accountId: email,
      secretEncrypted: encryptSecret(JSON.stringify(tokens)),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: { email, scopes: tokens.scope?.split(" ") ?? scopes },
    },
    { upsert: true, new: true, runValidators: true },
  );
  await invalidateDashboardCache(expectedOrgId);
}

export async function disconnectGoogle(orgId: string) {
  const saved = await ProviderIntegrationModel.findOne({ ownerId: orgId, provider: "google" }).select("+secretEncrypted");
  if (saved) {
    try {
      const credentials = JSON.parse(decryptSecret(saved.secretEncrypted)) as Credentials;
      const token = credentials.refresh_token || credentials.access_token;
      if (token) await oauthClient().revokeToken(token);
    } catch { /* Local deletion must still succeed if Google is unavailable. */ }
  }
  await ProviderIntegrationModel.deleteOne({ ownerId: orgId, provider: "google" });
  await invalidateDashboardCache(orgId);
}

export async function listGoogleCalendars(orgId: string) {
  const token = await accessToken(orgId);
  const data = await googleJson<{ items?: Array<{ id: string; summary: string; primary?: boolean; accessRole?: string; timeZone?: string }> }>(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer",
    token,
  );
  return (data.items ?? []).map((item) => ({
    id: item.id,
    name: item.summary,
    primary: item.primary === true,
    timezone: item.timeZone ?? "Asia/Kolkata",
  }));
}

export async function inspectGoogleSpreadsheet(orgId: string, spreadsheetId: string) {
  const id = spreadsheetId.trim().match(/\/spreadsheets\/d\/([^/]+)/)?.[1] ?? spreadsheetId.trim();
  if (!id) throw new HttpError(400, "Enter a Google spreadsheet URL or ID.");
  const token = await accessToken(orgId);
  const data = await googleJson<{ spreadsheetId: string; properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=spreadsheetId,properties.title,sheets.properties.title`,
    token,
  );
  return {
    id: data.spreadsheetId,
    name: data.properties?.title ?? "Google spreadsheet",
    sheets: (data.sheets ?? []).map((sheet) => sheet.properties?.title).filter((title): title is string => Boolean(title)),
  };
}

export async function googleCalendarAvailability(orgId: string, calendarId: string, start: string, end: string, timezone: string) {
  const token = await accessToken(orgId);
  return googleJson<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    token,
    {
      method: "POST",
      body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone: timezone, items: [{ id: calendarId }] }),
    },
  );
}

export async function createGoogleCalendarEvent(orgId: string, input: {
  calendarId: string; title: string; start: string; end: string; timezone: string;
  attendeeEmail?: string; description?: string;
}) {
  const token = await accessToken(orgId);
  const defaultDescription = input.description
    ? input.description
    : `Booked by ${await productNameForOrganization(orgId)} voice agent`;
  return googleJson<Record<string, unknown>>(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=all`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        summary: input.title,
        description: defaultDescription,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
        ...(input.attendeeEmail ? { attendees: [{ email: input.attendeeEmail }] } : {}),
      }),
    },
  );
}

function sheetRange(sheetName: string) {
  return `'${sheetName.replace(/'/g, "''")}'!A:Z`;
}

export async function appendGoogleSheetRow(orgId: string, spreadsheetId: string, sheetName: string, values: unknown[]) {
  const token = await accessToken(orgId);
  return googleJson<Record<string, unknown>>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(sheetName))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { method: "POST", body: JSON.stringify({ values: [values] }) },
  );
}
