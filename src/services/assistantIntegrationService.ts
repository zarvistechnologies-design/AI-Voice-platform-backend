import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { isTokenProvider } from "./tokenProviderService.js";
import { isAtlassianProvider } from "./atlassianIntegrationService.js";
import {
  listConnectedRazorpayPayments, previewConnectedTokenProvider,
  previewConnectedAtlassianProvider, previewConnectedCrmKeyProvider,
} from "./integrationService.js";
import { previewGoogleDrive, previewGmail, listGoogleCalendars } from "./googleWorkspaceService.js";
import { previewCrmRecords } from "./crmOAuthService.js";
import { previewRazorpayOAuthPayments } from "./razorpayOAuthService.js";

const googleFeatures = ["google_calendar", "google_sheets", "google_drive", "google_docs", "google_gmail"] as const;
export const voiceReadIntegrationIds = [
  "asana", "clickup", "linear", "monday", "notion", "atlassian", "jira", "freshsales", "prospeo",
  "zoho", "salesforce", "razorpay_api", "razorpay_oauth", "google_calendar", "google_drive", "google_docs", "google_gmail",
] as const;

export async function listAssistantIntegrations(orgId: string) {
  const connected = await ProviderIntegrationModel.find({ ownerId: orgId, status: "connected" })
    .select("provider accountId metadata lastVerifiedAt").lean();
  return connected.map((item) => ({
    provider: item.provider,
    account: item.accountId,
    features: item.provider === "google"
      ? googleFeatures.filter((feature) => {
          const scopes = Array.isArray(item.metadata?.scopes) ? item.metadata.scopes as string[] : [];
          if (feature === "google_calendar") return scopes.includes("https://www.googleapis.com/auth/calendar");
          if (feature === "google_sheets") return scopes.includes("https://www.googleapis.com/auth/spreadsheets");
          if (feature === "google_drive") return scopes.includes("https://www.googleapis.com/auth/drive.readonly");
          if (feature === "google_docs") return scopes.includes("https://www.googleapis.com/auth/documents.readonly") && scopes.includes("https://www.googleapis.com/auth/drive.metadata.readonly");
          return scopes.includes("https://www.googleapis.com/auth/gmail.readonly");
        })
      : [item.provider],
    lastVerifiedAt: item.lastVerifiedAt,
  }));
}

export async function previewAssistantIntegration(orgId: string, provider: string) {
  const id = provider.trim().toLowerCase();
  if (id === "google_calendar") return { items: await listGoogleCalendars(orgId) };
  if (id === "google_drive") return previewGoogleDrive(orgId);
  if (id === "google_docs") return previewGoogleDrive(orgId, true);
  if (id === "google_gmail") return previewGmail(orgId);
  if (id === "razorpay_api") return listConnectedRazorpayPayments(orgId);
  if (id === "razorpay_oauth") return previewRazorpayOAuthPayments(orgId);
  if (id === "zoho" || id === "salesforce") return previewCrmRecords(orgId, id);
  if (isTokenProvider(id)) return previewConnectedTokenProvider(orgId, id);
  if (isAtlassianProvider(id)) return previewConnectedAtlassianProvider(orgId, id);
  if (id === "freshsales" || id === "prospeo") return previewConnectedCrmKeyProvider(orgId, id);
  throw new HttpError(400, "This integration has no read-only preview. Use the Integrations page to manage it.");
}
