import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { getCrmOAuthCredentials } from "./crmOAuthService.js";
import { appendGoogleSheetRow, createGoogleCalendarEvent } from "./googleWorkspaceService.js";
import { createCalendlySchedulingLink, listCalendlyEventTypes } from "./integrationService.js";
import { getRazorpayOAuthAccessToken } from "./razorpayOAuthService.js";

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits || phone.trim();
}

export async function createRazorpayPaymentLinkForOrg(
  ownerId: string,
  input: {
    amount: number;
    currency?: string;
    description?: string;
    customerName?: string;
    customerPhone: string;
    customerEmail?: string;
    referenceId?: string;
  },
): Promise<{
  id: string;
  shortUrl: string;
  amount: number;
  currency: string;
  provider: "razorpay_api" | "razorpay_oauth";
}> {
  const amountMajor = Number(input.amount);
  if (!Number.isFinite(amountMajor) || amountMajor < 1) {
    throw new Error("Razorpay payment amount must be at least 1.");
  }
  const currency = (input.currency || "INR").toUpperCase();
  const amountMinor = Math.round(amountMajor * 100);

  const [apiIntegration, oauthIntegration] = await Promise.all([
    ProviderIntegrationModel.findOne({ ownerId, provider: "razorpay_api", status: "connected" }).select("+secretEncrypted"),
    ProviderIntegrationModel.findOne({ ownerId, provider: "razorpay_oauth", status: "connected" }).select("+secretEncrypted"),
  ]);

  let authHeader = "";
  let usedProvider: "razorpay_api" | "razorpay_oauth" = "razorpay_api";

  if (apiIntegration?.secretEncrypted) {
    const creds = JSON.parse(decryptSecret(apiIntegration.secretEncrypted)) as { keyId: string; keySecret: string };
    authHeader = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`, "utf8").toString("base64")}`;
    usedProvider = "razorpay_api";
  } else if (oauthIntegration?.secretEncrypted) {
    const token = await getRazorpayOAuthAccessToken(ownerId);
    authHeader = `Bearer ${token}`;
    usedProvider = "razorpay_oauth";
  } else {
    throw new Error("Connect Razorpay (API Keys or OAuth) in Integrations before generating payment links.");
  }

  const customerContact = cleanPhone(input.customerPhone);
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountMinor,
      currency,
      accept_partial: false,
      description: (input.description || "Payment via Vozon WhatsApp Automation").slice(0, 250),
      ...(input.referenceId ? { reference_id: input.referenceId.slice(0, 40) } : {}),
      customer: {
        name: (input.customerName || "Customer").slice(0, 100),
        contact: customerContact,
        ...(input.customerEmail ? { email: input.customerEmail } : {}),
      },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        source: "vozon_whatsapp_workflow",
        ownerId,
        customerPhone: customerContact,
        customerName: (input.customerName || "Customer").slice(0, 100),
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    short_url?: string;
    error?: { description?: string };
  };

  if (!response.ok || !data.short_url) {
    throw new Error(data?.error?.description || `Razorpay payment link creation failed (HTTP ${response.status}).`);
  }

  return {
    id: String(data.id ?? ""),
    shortUrl: String(data.short_url),
    amount: amountMajor,
    currency,
    provider: usedProvider,
  };
}

export async function bookConnectedCalendars(
  ownerId: string,
  input: {
    title: string;
    durationMinutes: number;
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
    timezone?: string;
    startIso?: string;
    provider?: "auto" | "google" | "calendly" | "all";
  },
): Promise<{
  syncedProviders: string[];
  calendarHtmlLink?: string;
  calendlyLink?: string;
  scheduledStartIso: string;
  errors: string[];
}> {
  const syncedProviders: string[] = [];
  const errors: string[] = [];
  let calendarHtmlLink: string | undefined;
  let calendlyLink: string | undefined;

  const durationMs = Math.max(15, Math.min(240, input.durationMinutes || 30)) * 60_000;
  const startDate = input.startIso ? new Date(input.startIso) : null;
  const validStart = startDate && !Number.isNaN(startDate.getTime()) && startDate.getTime() >= Date.now() + 60_000;
  const endDate = validStart ? new Date(startDate.getTime() + durationMs) : null;

  const [googleConn, calendlyConn] = await Promise.all([
    ProviderIntegrationModel.findOne({ ownerId, provider: "google", status: "connected" }).select("metadata").lean(),
    ProviderIntegrationModel.findOne({ ownerId, provider: "calendly", status: "connected" }).select("metadata").lean(),
  ]);
  const provider = input.provider || "auto";
  const useGoogle = provider === "google" || provider === "all" || (provider === "auto" && Boolean(googleConn && (validStart || !calendlyConn)));
  const useCalendly = provider === "calendly" || provider === "all" || (provider === "auto" && !useGoogle);

  if (useGoogle && !googleConn) errors.push("Google Calendar is not connected.");
  if (useCalendly && !calendlyConn) errors.push("Calendly is not connected.");
  if (useGoogle && googleConn) {
    try {
      if (!validStart || !endDate) throw new Error("A future appointment time is required to create a Google Calendar event.");
      const calendarId = String((googleConn.metadata as Record<string, unknown> | undefined)?.calendarId || "primary");
      const event = await createGoogleCalendarEvent(ownerId, {
        calendarId,
        title: `${input.title} — ${input.customerName || input.customerPhone}`,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        timezone: input.timezone || "Asia/Kolkata",
        attendeeEmail: input.customerEmail,
        description: `Booked autonomously via Vozon Workflow.\nContact: ${input.customerName || "Customer"} (${input.customerPhone})`,
      });
      calendarHtmlLink = typeof event.htmlLink === "string" ? event.htmlLink : undefined;
      syncedProviders.push("Google Calendar");
    } catch (err) {
      errors.push(`Google Calendar: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  if (useCalendly && calendlyConn) {
    try {
      const eventTypesRes = (await listCalendlyEventTypes(ownerId)) as {
        collection?: Array<{ uri?: string; name?: string }>;
      };
      const firstType = eventTypesRes.collection?.[0]?.uri;
      if (firstType) {
        const linkRes = (await createCalendlySchedulingLink(ownerId, firstType)) as {
          resource?: { booking_url?: string };
        };
        if (linkRes.resource?.booking_url) {
          calendlyLink = linkRes.resource.booking_url;
          syncedProviders.push("Calendly");
        }
      }
    } catch (err) {
      errors.push(`Calendly: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  return {
    syncedProviders,
    calendarHtmlLink,
    calendlyLink,
    scheduledStartIso: validStart ? startDate.toISOString() : "",
    errors,
  };
}

export async function syncLeadToConnectedCrms(
  ownerId: string,
  input: {
    contactName: string;
    contactPhone: string;
    contactEmail?: string;
    stage: string;
    tag: string;
    outcome?: string;
    summary?: string;
    spreadsheetId?: string;
    provider?: string;
  },
): Promise<{ syncedProviders: string[]; errors: string[] }> {
  const syncedProviders: string[] = [];
  const errors: string[] = [];

  const connected = await ProviderIntegrationModel.find({
    ownerId,
    status: "connected",
    provider: input.provider && input.provider !== "all" && input.provider !== "vozon"
      ? input.provider
      : { $in: input.provider === "vozon" ? [] : ["hubspot", "zoho", "salesforce", "highlevel", "freshsales", "google"] },
  }).select("+secretEncrypted");

  const fullName = (input.contactName || "Lead").trim();
  const [firstName, ...restName] = fullName.split(/\s+/);
  const lastName = restName.join(" ") || "Contact";

  for (const conn of connected) {
    try {
      if (conn.provider === "hubspot") {
        const token = decryptSecret(conn.secretEncrypted);
        const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: input.contactPhone }] }],
            limit: 1,
          }),
        });
        if (!searchRes.ok) throw new Error(`HubSpot contact search returned HTTP ${searchRes.status}`);
        const searchData = (await searchRes.json().catch(() => ({}))) as { results?: Array<{ id?: string }> };
        let contactId = searchData.results?.[0]?.id || "";
        if (!contactId) {
          const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
            method: "POST",
            signal: AbortSignal.timeout(12_000),
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              properties: {
                phone: input.contactPhone,
                firstname: firstName,
                lastname: lastName,
                ...(input.contactEmail ? { email: input.contactEmail } : {}),
              },
            }),
          });
          const created = (await createRes.json().catch(() => ({}))) as { id?: string };
          if (!createRes.ok || !created.id) throw new Error(`HubSpot contact creation returned HTTP ${createRes.status}`);
          contactId = created.id || "";
        }
        const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            properties: {
              hs_timestamp: new Date().toISOString(),
              hs_note_body: `Vozon Workflow CRM Sync<br>Stage: ${input.stage}<br>Tag: ${input.tag}<br>Outcome: ${input.outcome || "Synced"}<br>${input.summary || ""}`,
            },
            ...(contactId
              ? { associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] }
              : {}),
          }),
        });
        if (!noteRes.ok) throw new Error(`HubSpot note creation returned HTTP ${noteRes.status}`);
        syncedProviders.push("HubSpot");
      } else if (conn.provider === "zoho") {
        if ((conn.metadata as Record<string, unknown> | null)?.workflowWriteAccess !== true) throw new Error("Reconnect Zoho CRM to enable workflow lead creation.");
        const tokens = await getCrmOAuthCredentials(ownerId, "zoho");
        const res = await fetch(`${tokens.apiBase}/crm/v8/Leads`, {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { Authorization: `Zoho-oauthtoken ${tokens.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [
              {
                First_Name: firstName,
                Last_Name: lastName,
                Phone: input.contactPhone,
                Lead_Status: input.stage,
                Description: `Synced via Vozon Workflow. Tag: ${input.tag}. ${input.summary || ""}`,
                ...(input.contactEmail ? { Email: input.contactEmail } : {}),
              },
            ],
          }),
        });
        const result = await res.json().catch(() => null) as { data?: Array<{ status?: string; message?: string }> } | null;
        if (!res.ok || result?.data?.[0]?.status !== "success") {
          throw new Error(result?.data?.[0]?.message || `Zoho lead creation failed (HTTP ${res.status}).`);
        }
        syncedProviders.push("Zoho CRM");
      } else if (conn.provider === "salesforce") {
        const tokens = await getCrmOAuthCredentials(ownerId, "salesforce");
        const res = await fetch(`${tokens.apiBase}/services/data/v61.0/sobjects/Lead`, {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            FirstName: firstName,
            LastName: lastName,
            Company: "Vozon Lead",
            Phone: input.contactPhone,
            Status: input.stage,
            Description: `Tag: ${input.tag}. ${input.summary || ""}`,
            ...(input.contactEmail ? { Email: input.contactEmail } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        syncedProviders.push("Salesforce");
      } else if (conn.provider === "highlevel") {
        const creds = JSON.parse(decryptSecret(conn.secretEncrypted)) as { locationId: string; token: string };
        const res = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${creds.token}`,
            "Content-Type": "application/json",
            Version: "2021-07-28",
          },
          body: JSON.stringify({
            locationId: creds.locationId,
            firstName,
            lastName,
            name: fullName,
            phone: input.contactPhone,
            tags: [input.tag, input.stage].filter(Boolean),
            ...(input.contactEmail ? { email: input.contactEmail } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        syncedProviders.push("HighLevel");
      } else if (conn.provider === "freshsales") {
        const creds = JSON.parse(decryptSecret(conn.secretEncrypted)) as { site: string; apiKey: string };
        const res = await fetch(`${creds.site}/crm/sales/api/contacts`, {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { Authorization: `Token token=${creds.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            contact: {
              first_name: firstName,
              last_name: lastName,
              mobile_number: input.contactPhone,
              ...(input.contactEmail ? { email: input.contactEmail } : {}),
            },
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        syncedProviders.push("Freshsales");
      } else if (conn.provider === "google") {
        const meta = (conn.metadata ?? {}) as Record<string, unknown>;
        const sheetId = input.spreadsheetId || String(meta.spreadsheetId || "");
        if (sheetId) {
          const sheetName = String(meta.sheetName || "Sheet1");
          await appendGoogleSheetRow(ownerId, sheetId, sheetName, [
            new Date().toISOString(),
            fullName,
            input.contactPhone,
            input.stage,
            input.tag,
            input.outcome || "",
            input.summary || "",
          ]);
          syncedProviders.push("Google Sheets");
        } else throw new Error("Choose a Google Spreadsheet ID or configure a default Sheet.");
      }
    } catch (err) {
      errors.push(`${conn.provider}: ${err instanceof Error ? err.message : "sync failed"}`);
    }
  }

  return { syncedProviders, errors };
}

export async function notifyConnectedSlack(ownerId: string, text: string): Promise<boolean> {
  const slack = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "slack",
    status: "connected",
  }).select("+secretEncrypted");
  if (!slack?.secretEncrypted) return false;
  const webhookUrl = decryptSecret(slack.secretEncrypted);
  const res = await fetch(webhookUrl, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}
