import { nativeClinicConfig, type GuidedIntegrationMode } from "./guidedAgentTemplates.js";
import { nativeToolsForTemplate } from "./nativeWorkflowService.js";

export function guidedAgentProvisioning(input: {
  templateId: string;
  mode: GuidedIntegrationMode;
  answers: Record<string, string>;
}) {
  if (input.mode !== "native") return { tools: [] };

  return {
    tools: nativeToolsForTemplate(input.templateId),
    ...(input.templateId === "clinic_appointments"
      ? { nativeAppointments: nativeClinicConfig(input.answers) }
      : {}),
  };
}
