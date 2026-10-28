export function parseAppointmentToolResponse(responseText: string) {
  if (!responseText.trim()) return null;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function appointmentToolFailureMessage(data: Record<string, unknown> | null) {
  if (!data) return "";
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const failed = data.success === false
    || data.ok === false
    || data.booked === false
    || data.confirmed === false
    || status === "error"
    || status === "failed"
    || status === "failure";
  if (!failed) return "";

  const message = [data.error, data.message, data.reason, data.result]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .find(Boolean);
  return message || "The appointment action was not completed.";
}

export function hasAppointmentAvailabilityData(data: Record<string, unknown> | null) {
  if (!data) return false;
  const slots = data.availableSlots
    ?? data.available_times
    ?? data.availableTimes
    ?? data.free_times
    ?? data.freeTimes
    ?? data.slots
    ?? data.times;
  const options = data.options ?? data.rooms ?? data.tables;
  return data.success === true
    || data.ok === true
    || typeof data.available === "boolean"
    || typeof data.isAvailable === "boolean"
    || Array.isArray(data.doctors)
    || Array.isArray(slots)
    || Array.isArray(options);
}

function normalizedString(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function hasAppointmentBookingSuccess(data: Record<string, unknown> | null) {
  if (!data) return false;
  const status = normalizedString(data.status);
  const result = normalizedString(data.result);
  const appointment = data.appointment;
  return data.success === true
    || data.ok === true
    || data.booked === true
    || data.confirmed === true
    || ["success", "succeeded", "booked", "confirmed", "completed"].includes(status)
    || ["success", "appointment_booking_succeeded", "booking_succeeded", "booked", "confirmed"].includes(result)
    || typeof data.appointmentId === "string"
    || typeof data.bookingId === "string"
    || typeof data.id === "string"
    || (appointment !== null && typeof appointment === "object" && !Array.isArray(appointment));
}
