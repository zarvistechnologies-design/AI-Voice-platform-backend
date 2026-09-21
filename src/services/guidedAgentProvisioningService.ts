import { nativeClinicConfig, type GuidedIntegrationMode } from "./guidedAgentTemplates.js";
import { nativeToolsForTemplate } from "./nativeWorkflowService.js";
import { HttpError } from "../utils/httpError.js";

export function guidedAgentProvisioning(input: {
  templateId: string;
  mode: GuidedIntegrationMode;
  answers: Record<string, string>;
}) {
  const settings = {
    callbackEmail: input.answers.staffEmail || "",
    behavior: { transferPhone: input.answers.staffPhone || "", timezone: input.answers.businessTimezone || "Asia/Kolkata" },
    // Public opening hours remain in the prompt; the receptionist can answer after hours.
    businessHours: { timezone: input.answers.businessTimezone || "Asia/Kolkata", schedule: [] },
  };
  if (input.mode !== "native" && input.mode !== "requests") return { ...settings, tools: [] };

  return {
    ...settings,
    tools: nativeToolsForTemplate(input.templateId, input.mode),
    ...(input.templateId === "clinic_appointments" && input.mode === "native"
      ? { nativeAppointments: nativeClinicConfig(input.answers) }
      : {}),
  };
}

export function assertManagedSetupReady(templateId: string, mode: GuidedIntegrationMode, tools: { name: string; url: string; enabled?: boolean; managedBy?: string }[]) {
  if (mode !== "requests" && mode !== "native") return;
  const expected = nativeToolsForTemplate(templateId, mode);
  if (!expected.length || expected.some((required) => !tools.some((tool) => tool.enabled !== false && tool.managedBy === "vozon" && tool.name === required.name && tool.url === required.url))) {
    throw new HttpError(409, "This receptionist is missing a required action. Restore its business setup before activating it.");
  }
}
