import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { IntegrationDeliveryModel } from "../models/IntegrationDelivery.js";
import {
  connectNativeIntegration,
  disconnectNativeIntegration,
  nativeProviders,
  type NativeProvider,
} from "../services/integrationService.js";
import { HttpError } from "../utils/httpError.js";
import { env } from "../config/env.js";
import {
  completeGoogleAuthorization,
  disconnectGoogle,
  googleAuthorizationUrl,
  inspectGoogleSpreadsheet,
  listGoogleCalendars,
  appendGoogleSheetRow,
  createGoogleCalendarEvent,
} from "../services/googleWorkspaceService.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function provider(value: string): NativeProvider {
  if (nativeProviders.includes(value as NativeProvider)) return value as NativeProvider;
  throw new HttpError(404, "Integration provider not found.");
}

export async function listIntegrations(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const [integrations, latestDeliveries] = await Promise.all([
    ProviderIntegrationModel.find({ ownerId }).sort({ provider: 1 }),
    IntegrationDeliveryModel.find({ ownerId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  response.json({
    providers: ["vobiz", ...nativeProviders, "google"].map((id) => {
      const integration = integrations.find((item) => item.provider === id);
      return {
        id,
        connected: integration?.status === "connected",
        accountId: integration?.accountId ?? "",
        status: integration?.status ?? "disconnected",
        lastVerifiedAt: integration?.lastVerifiedAt ?? null,
        metadata: integration?.metadata ?? {},
        delivery: latestDeliveries.find((item) => item.provider === id)
          ? (() => {
              const item = latestDeliveries.find((delivery) => delivery.provider === id)!;
              return {
                status: item.status,
                attempts: item.attempts,
                errorMessage: item.errorMessage,
                deliveredAt: item.deliveredAt ?? null,
                updatedAt: item.updatedAt,
              };
            })()
          : null,
      };
    }),
  });
}

export async function connectIntegration(request: AuthenticatedRequest, response: Response) {
  const integration = await connectNativeIntegration(
    orgId(request),
    provider(request.params.provider),
    typeof request.body.credential === "string" ? request.body.credential : "",
  );
  response.json({
    id: integration.provider,
    connected: true,
    accountId: integration.accountId,
    status: integration.status,
    lastVerifiedAt: integration.lastVerifiedAt,
    metadata: integration.metadata,
  });
}

export async function disconnectIntegration(request: AuthenticatedRequest, response: Response) {
  await disconnectNativeIntegration(orgId(request), provider(request.params.provider));
  response.status(204).end();
}

export async function startGoogleOAuth(request: AuthenticatedRequest, response: Response) {
  response.json({ url: googleAuthorizationUrl(orgId(request)) });
}

export async function googleOAuthCallback(request: AuthenticatedRequest, response: Response) {
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!code || !state) throw new HttpError(400, "Google did not return an authorization code.");
  await completeGoogleAuthorization(orgId(request), code, state);
  response.redirect(`${env.clientUrl.replace(/\/$/, "")}/dashboard/integrations?google=connected`);
}

export async function removeGoogleConnection(request: AuthenticatedRequest, response: Response) {
  await disconnectGoogle(orgId(request));
  response.status(204).end();
}

export async function googleCalendars(request: AuthenticatedRequest, response: Response) {
  response.json({ calendars: await listGoogleCalendars(orgId(request)) });
}

export async function googleSpreadsheet(request: AuthenticatedRequest, response: Response) {
  response.json({ spreadsheet: await inspectGoogleSpreadsheet(orgId(request), String(request.body.spreadsheetId ?? "")) });
}

export async function testGoogleCalendar(request: AuthenticatedRequest, response: Response) {
  const start = new Date(Date.now() + 24 * 60 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const end = new Date(start.getTime() + 15 * 60_000);
  const event = await createGoogleCalendarEvent(orgId(request), {
    calendarId: String(request.body.calendarId ?? ""),
    title: "Vozon integration test",
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: String(request.body.timezone ?? "Asia/Kolkata"),
    description: "This test event confirms that Vozon can create appointments. You may delete it.",
  });
  response.json({ event });
}

export async function testGoogleSheet(request: AuthenticatedRequest, response: Response) {
  const result = await appendGoogleSheetRow(
    orgId(request),
    String(request.body.spreadsheetId ?? ""),
    String(request.body.sheetName ?? "Sheet1"),
    [new Date().toISOString(), "Vozon integration test", "success", "This row confirms the connection works."],
  );
  response.json({ result });
}
