import { randomBytes } from "node:crypto";
import { isValidObjectId } from "mongoose";

import { NativeAppointmentModel } from "../models/NativeAppointment.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import type { AgentWebhookTool, AgentToolRunResult } from "./agentToolService.js";

export const nativeAvailabilityUrl = "https://native.vozon.app/appointments/availability";
export const nativeBookingUrl = "https://native.vozon.app/appointments/book";

const text = (value: unknown, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const providerKey = (value: string) => value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();

export function nativeClinicAppointmentTools() {
  return [
    {
      name: "check_appointment_availability",
      description: "Check Vozon clinic availability for a date before offering any appointment. Use a YYYY-MM-DD date and a configured doctor name.",
      method: "POST" as const,
      url: nativeAvailabilityUrl,
      headers: {}, timeoutSeconds: 8, enabled: true, runAfterCall: false,
      executeAfterMessage: false, excludeSessionId: false, messages: [], managedBy: "vozon",
      parameters: [
        { name: "date", type: "string", description: "Requested local date in YYYY-MM-DD format.", required: true },
        { name: "provider", type: "string", description: "Doctor or provider name. Omit only when the caller has no preference.", required: false },
      ],
    },
    {
      name: "book_appointment",
      description: "Book an exact slot returned by check_appointment_availability after the caller confirms the doctor, date, and time. A booking is confirmed only when this tool returns success and a booking reference.",
      method: "POST" as const,
      url: nativeBookingUrl,
      headers: {}, timeoutSeconds: 8, enabled: true, runAfterCall: false,
      executeAfterMessage: false, excludeSessionId: false, messages: [], managedBy: "vozon",
      parameters: [
        { name: "slotId", type: "string", description: "The exact slotId returned by the availability tool.", required: true },
        { name: "patientName", type: "string", description: "Patient's full name.", required: true },
        { name: "patientPhone", type: "string", description: "Patient's callback number.", required: true },
        { name: "appointmentType", type: "string", description: "Visit type or reason, without medical diagnosis.", required: false },
        { name: "notes", type: "string", description: "Brief non-sensitive booking notes.", required: false },
      ],
    },
  ];
}

function partsAt(date: Date, timezone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function zonedDate(date: string, time: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) throw new HttpError(400, "Use date YYYY-MM-DD and time HH:mm.");
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +clock[1], +clock[2]);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = partsAt(new Date(candidate), timezone);
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    candidate += desired - represented;
  }
  const result = new Date(candidate);
  const final = partsAt(result, timezone);
  if (`${final.year}-${final.month}-${final.day}` !== date || `${final.hour}:${final.minute}` !== time) {
    throw new HttpError(400, "That local time does not exist in the configured timezone.");
  }
  return result;
}

function slotId(agentId: string, provider: string, start: Date) {
  return Buffer.from(JSON.stringify({ a: agentId, p: provider, s: start.toISOString() }), "utf8").toString("base64url");
}

function readSlotId(value: unknown) {
  try {
    const parsed = JSON.parse(Buffer.from(text(value, 2000), "base64url").toString("utf8")) as Record<string, unknown>;
    return { agentId: text(parsed.a), provider: text(parsed.p), start: new Date(text(parsed.s)) };
  } catch {
    throw new HttpError(400, "Use a slotId returned by check_appointment_availability.");
  }
}

async function configuredAgent(context: Record<string, unknown>) {
  const ownerId = text(context.owner_id);
  const agentId = text(context.agent_id);
  if (!ownerId || !isValidObjectId(agentId)) throw new HttpError(400, "Appointment tool context is missing.");
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId });
  const config = agent?.nativeAppointments;
  if (!agent || !config?.enabled) throw new HttpError(409, "Vozon appointment booking is not enabled for this agent.");
  return { agent, config, ownerId, agentId };
}

function selectedProviders(configured: string[], requested: string) {
  if (!configured.length) throw new HttpError(409, "Add at least one doctor to this clinic agent.");
  if (!requested) return configured;
  const found = configured.find((item) => providerKey(item) === providerKey(requested));
  if (!found) throw new HttpError(400, `Choose a configured doctor: ${configured.join(", ")}.`);
  return [found];
}

async function checkAvailability(args: Record<string, unknown>, context: Record<string, unknown>) {
  const { agent, agentId, config } = await configuredAgent(context);
  const date = text(args.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Date must use YYYY-MM-DD.");
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!config.weekdays.includes(day)) return { success: true, date, timezone: config.timezone, slots: [], message: "The clinic is closed on this day." };
  const providers = selectedProviders(config.providers, text(args.provider));
  const dayStart = zonedDate(date, config.startTime, config.timezone);
  const dayEnd = zonedDate(date, config.endTime, config.timezone);
  if (dayEnd <= dayStart) throw new HttpError(409, "Clinic booking hours are invalid.");
  const booked = await NativeAppointmentModel.find({
    agentId: agent._id, status: "booked", startAt: { $gte: dayStart, $lt: dayEnd },
  }).select("providerKey startAt endAt").lean();
  const now = Date.now();
  const slots: { slotId: string; provider: string; start: string; end: string; localTime: string }[] = [];
  for (const provider of providers) {
    for (let startMs = dayStart.getTime(); startMs + config.durationMinutes * 60_000 <= dayEnd.getTime(); startMs += config.durationMinutes * 60_000) {
      const endMs = startMs + config.durationMinutes * 60_000;
      const overlaps = booked.some((item) => item.providerKey === providerKey(provider)
        && item.startAt.getTime() < endMs && item.endAt.getTime() > startMs);
      if (startMs <= now || overlaps) continue;
      const start = new Date(startMs);
      const end = new Date(endMs);
      slots.push({
        slotId: slotId(agentId, provider, start), provider, start: start.toISOString(), end: end.toISOString(),
        localTime: new Intl.DateTimeFormat("en-IN", { timeZone: config.timezone, dateStyle: "medium", timeStyle: "short" }).format(start),
      });
      if (slots.length >= 24) break;
    }
    if (slots.length >= 24) break;
  }
  return { success: true, date, timezone: config.timezone, durationMinutes: config.durationMinutes, slots };
}

async function bookAppointment(args: Record<string, unknown>, context: Record<string, unknown>) {
  const { agent, ownerId, agentId, config } = await configuredAgent(context);
  const decoded = readSlotId(args.slotId);
  if (decoded.agentId !== agentId || Number.isNaN(decoded.start.getTime()) || decoded.start.getTime() <= Date.now()) {
    throw new HttpError(400, "This appointment slot is invalid or has expired. Check availability again.");
  }
  const provider = selectedProviders(config.providers, decoded.provider)[0];
  const local = partsAt(decoded.start, config.timezone);
  const localDate = `${local.year}-${local.month}-${local.day}`;
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  const expectedStart = zonedDate(localDate, `${local.hour}:${local.minute}`, config.timezone);
  const open = zonedDate(localDate, config.startTime, config.timezone);
  const close = zonedDate(localDate, config.endTime, config.timezone);
  if (!config.weekdays.includes(day) || expectedStart.getTime() !== decoded.start.getTime()
    || decoded.start < open || decoded.start.getTime() + config.durationMinutes * 60_000 > close.getTime()
    || (decoded.start.getTime() - open.getTime()) % (config.durationMinutes * 60_000) !== 0) {
    throw new HttpError(400, "This slot is outside the configured clinic schedule.");
  }
  const patientName = text(args.patientName, 160);
  const patientPhone = text(args.patientPhone, 40);
  if (!patientName || !patientPhone) throw new HttpError(400, "Patient name and phone number are required.");
  if (patientPhone.replace(/\D/g, "").length < 7) throw new HttpError(400, "Enter a valid patient callback number.");
  const endAt = new Date(decoded.start.getTime() + config.durationMinutes * 60_000);
  const conflict = await NativeAppointmentModel.exists({
    agentId: agent._id, providerKey: providerKey(provider), status: "booked",
    startAt: { $lt: endAt }, endAt: { $gt: decoded.start },
  });
  if (conflict) throw new HttpError(409, "That slot is no longer available. Check availability and offer another slot.");
  const bookingReference = `VZN-${randomBytes(4).toString("hex").toUpperCase()}`;
  try {
    const appointment = await NativeAppointmentModel.create({
      ownerId, agentId: agent._id, callId: text(context.call_id, 160), provider,
      providerKey: providerKey(provider), patientName, patientPhone,
      appointmentType: text(args.appointmentType, 160) || "Consultation", notes: text(args.notes, 1000),
      timezone: config.timezone, startAt: decoded.start,
      endAt, bookingReference,
    });
    return { success: true, bookingReference, status: appointment.status, provider, patientName,
      start: appointment.startAt.toISOString(), end: appointment.endAt.toISOString(), timezone: config.timezone };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) {
      throw new HttpError(409, "That slot was just booked. Check availability and offer another slot.");
    }
    throw error;
  }
}

export function isNativeAppointmentTool(tool: AgentWebhookTool) {
  return tool.managedBy === "vozon" && [nativeAvailabilityUrl, nativeBookingUrl].includes(tool.url);
}

export async function executeNativeAppointmentTool(tool: AgentWebhookTool, args: Record<string, unknown>, context: Record<string, unknown>): Promise<AgentToolRunResult> {
  const startedAt = Date.now();
  try {
    const data = tool.url === nativeAvailabilityUrl ? await checkAvailability(args, context) : await bookAppointment(args, context);
    return { ok: true, status: 200, elapsedMs: Date.now() - startedAt, responseText: JSON.stringify(data) };
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Appointment tool failed.";
    return { ok: false, status, elapsedMs: Date.now() - startedAt, responseText: JSON.stringify({ success: false, error: message }) };
  }
}
