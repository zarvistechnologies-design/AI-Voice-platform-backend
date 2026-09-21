import { createHash, randomBytes } from "node:crypto";
import { isValidObjectId } from "mongoose";

import { NativeWorkflowRecordModel } from "../models/NativeWorkflowRecord.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import type { AgentToolRunResult, AgentWebhookTool } from "./agentToolService.js";
import { nativeClinicAppointmentTools } from "./nativeAppointmentService.js";

type Parameter = { name: string; type: "string" | "number" | "boolean" | "object"; description: string; required: boolean };
type NativeToolDefinition = {
  name: string;
  legacyNames?: string[];
  kind: string;
  status: string;
  description: string;
  confirmationMessage: string;
  parameters: Parameter[];
};

const parameter = (name: string, description: string, required = true, type: Parameter["type"] = "string"): Parameter => ({ name, type, description, required });

const definitions: Record<string, NativeToolDefinition[]> = {
  clinic_appointments: [
    {
      name: "create_clinic_appointment_request", kind: "appointment_request", status: "pending_confirmation",
      description: "Save an appointment request for clinic staff. This does not reserve a slot; staff must confirm the appointment.",
      confirmationMessage: "The appointment request was saved. Clinic staff must confirm the doctor and time.",
      parameters: [parameter("customerName", "Patient name."), parameter("phone", "Callback number."), parameter("preferredDate", "Preferred date in YYYY-MM-DD."), parameter("preferredTime", "Preferred local time."), parameter("provider", "Requested doctor or specialty.", false), parameter("notes", "Brief appointment request, without a diagnosis.", false)],
    },
  ],
  restaurant_reservations: [
    {
      name: "create_restaurant_reservation", legacyNames: ["create_restaurant_reservation_request"], kind: "restaurant_reservation", status: "pending_confirmation",
      description: "Save a table request after repeating the date, time, and party size. Does not check table availability or reserve a table; staff must confirm.",
      confirmationMessage: "The reservation request was saved. Staff must confirm table availability.",
      parameters: [parameter("guestName", "Guest's full name."), parameter("phone", "Guest callback number."), parameter("date", "Requested date in YYYY-MM-DD."), parameter("time", "Requested local time."), parameter("partySize", "Number of guests.", true, "number"), parameter("specialRequests", "Seating, accessibility, allergy, or dietary request.", false)],
    },
  ],
  hotel_reservations: [
    {
      name: "create_hotel_booking", legacyNames: ["create_hotel_booking_request"], kind: "hotel_booking", status: "pending_confirmation",
      description: "Save a hotel stay request. Does not check room inventory or reserve a room; staff must confirm availability and terms.",
      confirmationMessage: "The stay request was saved. Staff must confirm room availability and terms.",
      parameters: [parameter("guestName", "Guest's full name."), parameter("phone", "Guest callback number."), parameter("checkIn", "Check-in date in YYYY-MM-DD."), parameter("checkOut", "Checkout date in YYYY-MM-DD."), parameter("guestCount", "Number of guests.", true, "number"), parameter("roomPreference", "Requested room type or preference.", false)],
    },
  ],
  real_estate_qualification: [
    {
      name: "save_qualified_property_lead", kind: "qualified_property_lead", status: "qualified",
      description: "Save a qualified real-estate lead in Vozon after collecting the required contact and property criteria.",
      confirmationMessage: "The qualified lead was saved in Vozon.",
      parameters: [parameter("name", "Lead's full name."), parameter("phone", "Lead callback number."), parameter("location", "Preferred location or project."), parameter("propertyType", "Requested property type."), parameter("budget", "Approximate budget."), parameter("timeline", "Purchase or rental timeline."), parameter("notes", "Other qualification notes.", false)],
    },
    {
      name: "create_site_visit_request", kind: "site_visit", status: "pending_confirmation",
      description: "Save a property site visit request. Staff must confirm the property and visit time.",
      confirmationMessage: "The site visit request was saved. Staff must confirm the visit time.",
      parameters: [parameter("name", "Visitor's full name."), parameter("phone", "Visitor callback number."), parameter("property", "Property or project requested."), parameter("preferredDate", "Preferred date in YYYY-MM-DD."), parameter("preferredTime", "Preferred local time."), parameter("notes", "Additional visit notes.", false)],
    },
  ],
  service_booking: [
    {
      name: "create_service_booking", legacyNames: ["create_service_booking_request"], kind: "service_booking", status: "pending_confirmation",
      description: "Save a service request with the address and preferred time. Does not reserve a technician; staff must confirm coverage, price, and availability.",
      confirmationMessage: "The service request was saved. Staff must confirm the service and appointment.",
      parameters: [parameter("customerName", "Customer's full name."), parameter("phone", "Customer callback number."), parameter("serviceType", "Requested service."), parameter("serviceLocation", "Service address or area."), parameter("preferredDate", "Preferred date in YYYY-MM-DD."), parameter("preferredTime", "Preferred local time."), parameter("issueDetails", "Brief description of the issue.", false)],
    },
  ],
  payment_reminders: [
    {
      name: "record_payment_promise", kind: "payment_promise", status: "promised",
      description: "Record a customer's promise-to-pay in Vozon. This does not take payment or mark an invoice paid.",
      confirmationMessage: "The payment promise was recorded without marking the invoice paid.",
      parameters: [parameter("customerName", "Verified customer's name."), parameter("phone", "Customer callback number."), parameter("invoiceReference", "Invoice reference stated or supplied by the campaign."), parameter("promiseDate", "Promised payment date in YYYY-MM-DD."), parameter("amount", "Amount promised in INR.", false, "number"), parameter("notes", "Brief customer notes.", false)],
    },
    {
      name: "record_payment_dispute", kind: "payment_dispute", status: "needs_review",
      description: "Record an invoice dispute for staff review. Do not claim the balance changed or the dispute was resolved.",
      confirmationMessage: "The payment dispute was recorded for staff review.",
      parameters: [parameter("customerName", "Verified customer's name."), parameter("phone", "Customer callback number."), parameter("invoiceReference", "Disputed invoice reference."), parameter("reason", "Customer's dispute reason."), parameter("requestedFollowUp", "Requested next step.", false)],
    },
  ],
  customer_feedback: [
    {
      name: "record_customer_feedback", kind: "customer_feedback", status: "recorded",
      description: "Store the customer's rating and comments in Vozon after the caller agrees to give feedback.",
      confirmationMessage: "The customer feedback was recorded.",
      parameters: [parameter("customerName", "Customer's name when provided.", false), parameter("phone", "Customer callback number when provided.", false), parameter("rating", "Customer rating.", true, "number"), parameter("feedback", "Customer's comments."), parameter("topic", "Visit, order, or service being reviewed.", false), parameter("followUpRequested", "Whether the customer wants a response.", false, "boolean")],
    },
    {
      name: "create_customer_follow_up", kind: "customer_follow_up", status: "needs_review",
      description: "Create a Vozon staff follow-up item when the customer asks for help or the configured escalation threshold is met.",
      confirmationMessage: "A customer follow-up item was created for staff review.",
      parameters: [parameter("customerName", "Customer's name."), parameter("phone", "Customer callback number."), parameter("reason", "Why staff should follow up."), parameter("priority", "Low, medium, high, or urgent.", false)],
    },
  ],
};

const toolUrl = (templateId: string, name: string) => `https://native.vozon.app/workflows/${templateId}/${name}`;

const staffRequest: NativeToolDefinition = {
  name: "create_staff_request", kind: "staff_request", status: "needs_review",
  description: "Save an enquiry, callback, change, cancellation, or incomplete request for staff. This does not change or cancel an existing booking. Use when another action cannot be completed.",
  confirmationMessage: "The request was saved for staff review. No booking or change has been confirmed.",
  parameters: [parameter("customerName", "Caller name when provided.", false), parameter("phone", "Callback number when provided.", false), parameter("request", "What the caller wants staff to help with, including any booking reference."), parameter("preferredTime", "Preferred time for staff to respond.", false)],
};

export function nativeToolsForTemplate(templateId: string, mode: "native" | "requests" = "native") {
  if (templateId === "clinic_appointments" && mode === "native") return nativeClinicAppointmentTools();
  const configured = definitions[templateId];
  if (!configured) return [];
  return [...configured, ...(mode === "requests" ? [staffRequest] : [])].map((definition) => ({
    name: definition.name,
    description: definition.description,
    method: "POST" as const,
    url: toolUrl(templateId, definition.name),
    headers: {}, timeoutSeconds: 8, enabled: true, parameters: definition.parameters,
    runAfterCall: false, executeAfterMessage: false, excludeSessionId: false, messages: [], managedBy: "vozon",
  }));
}

function definitionFor(tool: AgentWebhookTool) {
  for (const [templateId, templateDefinitions] of Object.entries(definitions)) {
    const definition = [...templateDefinitions, staffRequest].find((item) => {
      const names = [item.name, ...(item.legacyNames ?? [])];
      return names.some((name) => tool.url === toolUrl(templateId, name) && tool.name === name);
    });
    if (definition) return { templateId, definition };
  }
  return null;
}

export function isNativeWorkflowTool(tool: AgentWebhookTool) {
  return tool.managedBy === "vozon" && definitionFor(tool) !== null;
}

export function nativeWorkflowDescription(tool: AgentWebhookTool) {
  return tool.managedBy === "vozon" ? definitionFor(tool)?.definition.description : undefined;
}

const cleanText = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";

function normalizedValue(field: Parameter, value: unknown) {
  if (field.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, `${field.name} must be a number.`);
    return number;
  }
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    throw new HttpError(400, `${field.name} must be true or false.`);
  }
  if (field.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${field.name} must be an object.`);
    return value;
  }
  return String(value).trim().slice(0, 1000);
}

export function validateWorkflowData(kind: string, data: Record<string, unknown>) {
  for (const key of ["date", "checkIn", "checkOut", "preferredDate", "promiseDate"]) {
    if (data[key] !== undefined) {
      const date = String(data[key]);
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new HttpError(400, `${key} must be a valid date in YYYY-MM-DD.`);
      }
    }
  }
  if (data.checkIn && data.checkOut && String(data.checkOut) <= String(data.checkIn)) {
    throw new HttpError(400, "Checkout must be after check-in.");
  }
  for (const key of ["partySize", "guestCount"]) {
    if (data[key] !== undefined && Number(data[key]) < 1) throw new HttpError(400, `${key} must be at least 1.`);
  }
  if (kind === "customer_feedback" && (Number(data.rating) < 1 || Number(data.rating) > 5)) {
    throw new HttpError(400, "rating must be between 1 and 5.");
  }
  if (data.amount !== undefined && Number(data.amount) < 0) throw new HttpError(400, "amount cannot be negative.");
}

function contactValue(data: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = cleanText(data[name], name === "phone" ? 40 : 160);
    if (value) return value;
  }
  return "";
}

export async function executeNativeWorkflowTool(tool: AgentWebhookTool, args: Record<string, unknown>, context: Record<string, unknown>): Promise<AgentToolRunResult> {
  const startedAt = Date.now();
  try {
    const matched = definitionFor(tool);
    if (!matched) throw new HttpError(404, "Vozon workflow tool not found.");
    const ownerId = cleanText(context.owner_id, 160);
    const agentId = cleanText(context.agent_id, 160);
    if (!ownerId || !isValidObjectId(agentId)) throw new HttpError(400, "Workflow tool context is missing.");
    const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("guidedSetup tools");
    if (!agent || !["native", "requests"].includes(agent.guidedSetup?.integrationMode ?? "") || agent.guidedSetup?.templateId !== matched.templateId
      || !agent.tools.some((configured) => configured.enabled && configured.managedBy === "vozon" && configured.name === tool.name && configured.url === tool.url)) {
      throw new HttpError(409, "This Vozon workflow tool is not enabled for the agent.");
    }
    const data: Record<string, unknown> = {};
    for (const field of matched.definition.parameters) {
      const value = args[field.name];
      const missing = value === undefined || value === null || (typeof value === "string" && !value.trim());
      if (field.required && missing) throw new HttpError(400, `${field.name} is required.`);
      if (!missing) data[field.name] = normalizedValue(field, value);
    }
    validateWorkflowData(matched.definition.kind, data);
    const contactName = contactValue(data, ["guestName", "customerName", "name"]);
    const contactPhone = contactValue(data, ["phone"]);
    if (contactPhone && contactPhone.replace(/\D/g, "").length < 7) throw new HttpError(400, "Enter a valid callback number.");
    const scheduledForText = [data.date, data.time].filter(Boolean).join(" ")
      || [data.preferredDate, data.preferredTime].filter(Boolean).join(" ")
      || [data.checkIn, data.checkOut].filter(Boolean).join(" to ")
      || cleanText(data.promiseDate, 40);
    const callId = cleanText(context.call_id, 160);
    const dedupeKey = callId ? createHash("sha256").update(JSON.stringify(["request-v2", ownerId, agentId, callId, matched.definition.kind, data])).digest("hex") : "";
    const reference = `VZN-${randomBytes(4).toString("hex").toUpperCase()}`;
    // Saving a request does not reserve inventory or complete the underlying action.
    const resolvedStatus = matched.definition.status;
    const resolvedMessage = matched.definition.confirmationMessage;
    const recordInput = {
      ownerId, agentId: agent._id, callId, dedupeKey, templateId: matched.templateId,
      kind: matched.definition.kind, status: resolvedStatus, reference, contactName, contactPhone,
      scheduledForText, summary: resolvedMessage, data,
    };
    const record = dedupeKey
      ? await NativeWorkflowRecordModel.findOneAndUpdate(
          { dedupeKey }, { $setOnInsert: recordInput }, { upsert: true, new: true, setDefaultsOnInsert: true },
        )
      : await NativeWorkflowRecordModel.create(recordInput);
    // The existing post-call notification service reads these fields. Email delivery
    // is separate from saving the request and must never be claimed by this tool.
    if (isValidObjectId(callId)) {
      const callbackReason = contactValue(data, ["request", "reason", "issueDetails", "feedback", "notes", "serviceType", "property", "invoiceReference"])
        || resolvedMessage;
      const callbackFields: Record<string, unknown> = {
        callbackRequested: true,
        "callbackDetails.reason": callbackReason,
        "callbackDetails.requestedAt": new Date(),
      };
      if (contactName) callbackFields["callbackDetails.callerName"] = contactName;
      if (contactPhone) callbackFields["callbackDetails.callbackNumber"] = contactPhone;
      if (scheduledForText) callbackFields["callbackDetails.preferredTime"] = scheduledForText;
      await CallDetailRecordModel.updateOne(
        { _id: callId, ownerId, agentId: agent._id },
        { $set: callbackFields, $addToSet: { tags: "follow-up" } },
      ).catch((error: unknown) => console.error("Could not flag saved request for staff notification", { agentId, callId, error: error instanceof Error ? error.message : "Unknown error" }));
    }
    return {
      ok: true, status: 200, elapsedMs: Date.now() - startedAt,
      responseText: JSON.stringify({ success: true, recorded: true, confirmed: resolvedStatus === "qualified", status: resolvedStatus, reference: record.reference, message: resolvedMessage }),
    };
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    return { ok: false, status, elapsedMs: Date.now() - startedAt, responseText: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Workflow tool failed." }) };
  }
}
