import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client, type Credentials } from "google-auth-library";

import { env } from "../config/env.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
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
  await IntegrationDeliveryModel.updateMany(
    {
      ownerId: expectedOrgId,
      provider: "google_sheets",
      status: { $in: ["retrying", "failed"] },
    },
    {
      $set: { status: "pending", nextAttemptAt: new Date(), errorMessage: "" },
      $unset: { deliveryLeaseUntil: "", deliveryToken: "" },
    },
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

export function googleSpreadsheetId(value: string) {
  const trimmed = value.trim();
  return trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? trimmed;
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
  const id = googleSpreadsheetId(spreadsheetId);
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

export function googleCalendarWindow(start: string, end: string, options: { requireFuture?: boolean } = {}) {
  const hasOffset = (value: string) => /(Z|[+-]\d{2}:\d{2})$/i.test(value.trim());
  if (!hasOffset(start) || !hasOffset(end)) {
    throw new HttpError(400, "Calendar times must be ISO 8601 date-times with a timezone offset.");
  }
  const startAt = new Date(start);
  const endAt = new Date(end);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new HttpError(400, "Enter valid calendar start and end times.");
  }
  if (endAt <= startAt) throw new HttpError(400, "The appointment end time must be after its start time.");
  if (endAt.getTime() - startAt.getTime() > 24 * 60 * 60_000) {
    throw new HttpError(400, "An appointment cannot be longer than 24 hours.");
  }
  if (options.requireFuture && startAt.getTime() <= Date.now()) {
    throw new HttpError(400, "Appointments must be booked for a future time.");
  }
  return { startAt, endAt, start: startAt.toISOString(), end: endAt.toISOString() };
}

async function calendarBusyPeriods(token: string, calendarId: string, start: string, end: string, timezone: string) {
  const data = await googleJson<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    token,
    {
      method: "POST",
      body: JSON.stringify({ timeMin: start, timeMax: end, timeZone: timezone, items: [{ id: calendarId }] }),
    },
  );
  const calendar = data.calendars?.[calendarId];
  if (calendar?.errors?.length) throw new HttpError(400, "Google Calendar could not check this calendar's availability.");
  return calendar?.busy ?? [];
}

export async function googleCalendarAvailability(orgId: string, calendarId: string, start: string, end: string, timezone: string) {
  const window = googleCalendarWindow(start, end);
  const token = await accessToken(orgId);
  const busy = await calendarBusyPeriods(token, calendarId, window.start, window.end, timezone);
  return { available: busy.length === 0, start: window.start, end: window.end, timezone, busy };
}

export async function createGoogleCalendarEvent(orgId: string, input: {
  calendarId: string; title: string; start: string; end: string; timezone: string;
  attendeeEmail?: string; description?: string;
}) {
  const window = googleCalendarWindow(input.start, input.end, { requireFuture: true });
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new HttpError(400, "Enter an appointment title.");
  const attendeeEmail = input.attendeeEmail?.trim().toLowerCase();
  if (attendeeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)) {
    throw new HttpError(400, "Enter a valid attendee email address.");
  }
  const token = await accessToken(orgId);
  const busy = await calendarBusyPeriods(token, input.calendarId, window.start, window.end, input.timezone);
  if (busy.length) throw new HttpError(409, "That time is no longer available. Check availability and offer another time.");
  const defaultDescription = input.description
    ? input.description
    : `Booked by ${await productNameForOrganization(orgId)} voice agent`;
  return googleJson<Record<string, unknown>>(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=all`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        summary: title,
        description: defaultDescription.slice(0, 5000),
        start: { dateTime: window.start, timeZone: input.timezone },
        end: { dateTime: window.end, timeZone: input.timezone },
        ...(attendeeEmail ? { attendees: [{ email: attendeeEmail }] } : {}),
      }),
    },
  );
}

function sheetRange(sheetName: string) {
  return `'${sheetName.replace(/'/g, "''")}'!A:Z`;
}

function quotedSheetName(sheetName: string) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function columnName(columnCount: number) {
  let value = Math.max(1, Math.floor(columnCount));
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function normalizedHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function sheetCellValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value).slice(0, 5000);
  } catch {
    return String(value).slice(0, 5000);
  }
}

export type GoogleSheetColumn = { key: string; label: string };

async function insertGoogleSheetHeaderRow(token: string, spreadsheetId: string, sheetName: string) {
  const metadata = await googleJson<{
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
    token,
  );
  const sheet = (metadata.sheets ?? []).find((item) => item.properties?.title === sheetName);
  if (!Number.isInteger(sheet?.properties?.sheetId)) {
    throw new HttpError(400, `Google Sheet tab "${sheetName}" was not found.`);
  }
  await googleJson<Record<string, unknown>>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: {
              sheetId: sheet!.properties!.sheetId,
              dimension: "ROWS",
              startIndex: 0,
              endIndex: 1,
            },
            inheritFromBefore: false,
          },
        }],
      }),
    },
  );
}

async function updateGoogleSheetHeader(
  token: string,
  spreadsheetId: string,
  sheetName: string,
  headers: string[],
) {
  const range = `${quotedSheetName(sheetName)}!A1:${columnName(headers.length)}1`;
  await googleJson<Record<string, unknown>>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [headers] }),
    },
  );
}

/**
 * Appends named records under a stable header row. Existing non-header data is
 * preserved by inserting the header above it, and newly discovered columns are
 * added to the right without changing the position of existing columns.
 */
export async function appendGoogleSheetRecords(
  orgId: string,
  spreadsheetId: string,
  sheetName: string,
  columns: GoogleSheetColumn[],
  records: Array<Record<string, unknown>>,
) {
  if (!records.length) return {};
  const requestedColumns = columns
    .map((column) => ({ key: column.key.trim(), label: column.label.trim().slice(0, 120) }))
    .filter((column) => column.key && column.label)
    .filter((column, index, all) => all.findIndex((candidate) => candidate.key === column.key) === index);
  if (!requestedColumns.length) throw new HttpError(400, "Google Sheets export has no columns.");

  const token = await accessToken(orgId);
  const id = googleSpreadsheetId(spreadsheetId);
  const headerRange = `${quotedSheetName(sheetName)}!1:1`;
  const headerResponse = await googleJson<{ values?: unknown[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(headerRange)}`,
    token,
  );
  let headers = (headerResponse.values?.[0] ?? []).map((value) => String(value ?? "").trim());
  while (headers.length && !headers.at(-1)) headers.pop();

  const recognizedHeader = normalizedHeader(headers[0]) === "timestamp"
    && headers.some((header) => normalizedHeader(header) === "call id");
  if (headers.length && !recognizedHeader) {
    await insertGoogleSheetHeaderRow(token, id, sheetName);
    headers = [];
  }

  const existingLabels = new Set(headers.map(normalizedHeader));
  for (const column of requestedColumns) {
    if (!existingLabels.has(normalizedHeader(column.label))) {
      headers.push(column.label);
      existingLabels.add(normalizedHeader(column.label));
    }
  }
  await updateGoogleSheetHeader(token, id, sheetName, headers);

  const columnByLabel = new Map(
    requestedColumns.map((column) => [normalizedHeader(column.label), column] as const),
  );
  const values = records.map((record) => headers.map((header) => {
    const column = columnByLabel.get(normalizedHeader(header));
    return column ? sheetCellValue(record[column.key]) : "";
  }));
  const appendRange = `${quotedSheetName(sheetName)}!A:${columnName(headers.length)}`;
  return googleJson<Record<string, unknown>>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    { method: "POST", body: JSON.stringify({ values }) },
  );
}

export async function appendGoogleSheetRows(orgId: string, spreadsheetId: string, sheetName: string, values: unknown[][]) {
  if (!values.length) return {};
  const token = await accessToken(orgId);
  const id = googleSpreadsheetId(spreadsheetId);
  return googleJson<Record<string, unknown>>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(sheetRange(sheetName))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { method: "POST", body: JSON.stringify({ values }) },
  );
}

export async function appendGoogleSheetRow(orgId: string, spreadsheetId: string, sheetName: string, values: unknown[]) {
  return appendGoogleSheetRows(orgId, spreadsheetId, sheetName, [values]);
}
