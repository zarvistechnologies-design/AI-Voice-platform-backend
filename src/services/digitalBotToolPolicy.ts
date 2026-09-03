import { env } from "../config/env.js";

export type DigitalBotToolLike = {
  name?: string;
  url?: string;
  managedBy?: string;
};

export type DigitalBotAppointmentToolKind = "availability" | "booking";

const digitalBotManagedBy = "digitalbot";
const knownDigitalBotWebhookOrigin = "https://mcp-server-61zc.onrender.com";
const availabilityNames = new Set(["check_availability", "check_doctor_availability", "digitalbot_check_availability"]);
const bookingNames = new Set(["create_booking", "book_appointment", "digitalbot_book_appointment"]);

export const digitalBotInstructionStart = "<!-- VOZON_DIGITALBOT_APPOINTMENT_INSTRUCTIONS_START -->";
export const digitalBotInstructionEnd = "<!-- VOZON_DIGITALBOT_APPOINTMENT_INSTRUCTIONS_END -->";

function endpointKind(urlValue: string | undefined): DigitalBotAppointmentToolKind | null {
  if (!urlValue) return null;
  try {
    const path = new URL(urlValue).pathname.replace(/\/+$/, "");
    if (path === "/api/availability") return "availability";
    if (path === "/api/book-appointment") return "booking";
    return null;
  } catch {
    return null;
  }
}

function trustedDigitalBotOrigin(urlValue: string | undefined) {
  if (!urlValue) return false;
  try {
    const origin = new URL(urlValue).origin.toLowerCase();
    const configuredOrigin = new URL(env.digitalbotWebhookBaseUrl).origin.toLowerCase();
    return origin === configuredOrigin || origin === knownDigitalBotWebhookOrigin;
  } catch {
    return false;
  }
}

export function digitalBotAppointmentWebhookKind(
  tool: DigitalBotToolLike,
): DigitalBotAppointmentToolKind | null {
  const kind = endpointKind(tool.url);
  if (!kind) return null;
  return tool.managedBy === digitalBotManagedBy || trustedDigitalBotOrigin(tool.url) ? kind : null;
}

export function digitalBotAppointmentToolKind(
  tool: DigitalBotToolLike,
): DigitalBotAppointmentToolKind | null {
  const name = String(tool.name ?? "");
  if (availabilityNames.has(name)) return "availability";
  if (bookingNames.has(name)) return "booking";
  return digitalBotAppointmentWebhookKind(tool);
}

export function isDigitalBotManagedAppointmentTool(tool: DigitalBotToolLike) {
  return tool.managedBy === digitalBotManagedBy;
}

export function digitalBotToolActivationPlan<
  CurrentTool extends DigitalBotToolLike,
  Definition extends DigitalBotToolLike,
>(currentTools: CurrentTool[], definitions: Definition[]) {
  const manualKinds = new Set(
    currentTools
      .filter((tool) => tool.managedBy !== digitalBotManagedBy)
      .map(digitalBotAppointmentToolKind)
      .filter((kind): kind is DigitalBotAppointmentToolKind => kind !== null),
  );
  const manualNames = new Set(
    currentTools
      .filter((tool) => tool.managedBy !== digitalBotManagedBy)
      .map((tool) => String(tool.name ?? ""))
      .filter(Boolean),
  );
  const preservedTools = currentTools.filter((tool) => !isDigitalBotManagedAppointmentTool(tool));
  const missingDefinitions = definitions.filter((tool) => {
    const kind = digitalBotAppointmentToolKind(tool);
    const name = String(tool.name ?? "");
    return !manualNames.has(name) && (kind === null || !manualKinds.has(kind));
  });
  return {
    tools: [...preservedTools, ...missingDefinitions],
    preservedTools,
    missingDefinitions,
  };
}

export function removeDigitalBotManagedTools<Tool extends DigitalBotToolLike>(tools: Tool[]) {
  return tools.filter((tool) => !isDigitalBotManagedAppointmentTool(tool));
}

export function stripDigitalBotAppointmentInstruction(prompt: string) {
  return prompt
    .replace(
      new RegExp(`${digitalBotInstructionStart}[\\s\\S]*?${digitalBotInstructionEnd}`, "g"),
      "",
    )
    .trim();
}
