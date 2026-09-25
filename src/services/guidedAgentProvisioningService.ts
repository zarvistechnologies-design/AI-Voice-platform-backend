import { nativeClinicConfig, type GuidedIntegrationMode } from "./guidedAgentTemplates.js";
import { nativeToolsForTemplate } from "./nativeWorkflowService.js";
import { HttpError } from "../utils/httpError.js";

export function guidedAgentProvisioning(input: {
  templateId: string;
  mode: GuidedIntegrationMode;
  answers: Record<string, string>;
  googleCalendar?: {
    enabled?: boolean;
    calendarId?: string;
    calendarName?: string;
    timezone?: string;
    appointmentDurationMinutes?: number;
  };
  googleSheets?: {
    enabled?: boolean;
    spreadsheetId?: string;
    spreadsheetName?: string;
    sheetName?: string;
  };
}) {
  const duration = Number(input.answers.appointmentDuration) || 30;
  const timezone = input.answers.appointmentTimezone || input.answers.businessTimezone || "Asia/Kolkata";
  const settings = {
    callbackEmail: input.answers.staffEmail || "",
    behavior: { transferPhone: input.answers.staffPhone || "", timezone },
    // Public opening hours remain in the prompt; the receptionist can answer after hours.
    businessHours: { timezone, schedule: [] },
  };

  const calEnabled = Boolean(input.mode === "google_workspace" || input.googleCalendar?.enabled);
  const sheetsEnabled = Boolean(input.mode === "google_workspace" || input.googleSheets?.enabled);

  const googleCalendar = calEnabled ? {
    enabled: true,
    calendarId: input.googleCalendar?.calendarId || "primary",
    calendarName: input.googleCalendar?.calendarName || "Primary Calendar",
    timezone: input.googleCalendar?.timezone || timezone,
    appointmentDurationMinutes: input.googleCalendar?.appointmentDurationMinutes || duration,
  } : undefined;

  const googleSheets = sheetsEnabled ? {
    enabled: true,
    spreadsheetId: input.googleSheets?.spreadsheetId || "",
    spreadsheetName: input.googleSheets?.spreadsheetName || `${input.answers.businessName || "Clinic"} Bookings`,
    sheetName: input.googleSheets?.sheetName || "Bookings",
  } : undefined;

  const googleTools = calEnabled ? [
    {
      name: "check_google_calendar_availability",
      description: "Check busy periods in Google Calendar before offering an appointment slot.",
      url: "https://calendar.google.com/availability",
      enabled: true,
      managedBy: "vozon",
    },
    {
      name: "book_google_calendar_appointment",
      description: "Book a confirmed appointment in Google Calendar for the caller.",
      url: "https://calendar.google.com/book",
      enabled: true,
      managedBy: "vozon",
    },
  ] : [];

  const baseTools = input.mode === "google_workspace"
    ? nativeToolsForTemplate(input.templateId, "requests")
    : (input.mode === "native" || input.mode === "requests")
    ? nativeToolsForTemplate(input.templateId, input.mode)
    : [];

  return {
    ...settings,
    tools: [...baseTools, ...googleTools],
    ...(input.templateId === "clinic_appointments" && input.mode === "native"
      ? { nativeAppointments: nativeClinicConfig(input.answers) }
      : {}),
    ...(googleCalendar ? { googleCalendar } : {}),
    ...(googleSheets ? { googleSheets } : {}),
  };
}

export function assertManagedSetupReady(templateId: string, mode: GuidedIntegrationMode, tools: { name: string; url: string; enabled?: boolean; managedBy?: string }[]) {
  if (mode !== "requests" && mode !== "native") return;
  const expected = nativeToolsForTemplate(templateId, mode);
  if (!expected.length || expected.some((required) => !tools.some((tool) => tool.enabled !== false && tool.managedBy === "vozon" && tool.name === required.name && tool.url === required.url))) {
    throw new HttpError(409, "This receptionist is missing a required action. Restore its business setup before activating it.");
  }
}
