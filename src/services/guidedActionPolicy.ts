/** Shared by generated instructions and runtime so saved prompts cannot overpromise. */
export function guidedActionPolicy(templateId: string, mode: string) {
  if (mode !== "native" && mode !== "requests") return "";
  const rules: Record<string, string> = {
    restaurant_reservations: "Use create_restaurant_reservation to save a table request. It does not check table capacity or reserve a table. Staff must confirm the reservation.",
    clinic_appointments: mode === "native"
      ? "Use check_appointment_availability before offering times. Book only with the exact slotId returned after the caller confirms. Confirm a new appointment only when book_appointment returns success=true, confirmed=true, status=booked, and a bookingReference. This schedule is held in Vozon; do not imply another calendar was updated."
      : "Use create_clinic_appointment_request to save an appointment request. Staff must confirm the doctor and time; no appointment has been booked.",
    hotel_reservations: "Use create_hotel_booking to save a stay request. It does not check room inventory or rates or reserve a room. Staff must confirm availability and terms.",
    real_estate_qualification: "Use save_qualified_property_lead to save the caller's property needs. Use create_site_visit_request for a requested visit; staff must confirm availability and the visit time.",
    service_booking: "Use create_service_booking to save a service request. It does not check staff availability or service coverage. Staff must confirm the service, price, and appointment.",
    payment_reminders: "Use record_payment_promise or record_payment_dispute to save the customer's response. These tools do not verify identity, look up invoices, take payment, change a balance, or resolve disputes. State an amount only from verified business data after the approved identity check.",
    customer_feedback: "Use record_customer_feedback to save voluntary feedback and create_customer_follow_up for requested help. A saved follow-up item still needs staff review; it does not resolve the complaint.",
  };
  if (!rules[templateId]) return "";
  return [
    "CURRENT ACTION RULES (take precedence over older booking instructions):",
    rules[templateId],
    "Repeat the key details and get the caller's agreement before saving. Say a request or record was saved only after its tool returns success=true and a reference. A reference alone is not a confirmed booking.",
    "When confirmed=false or status=pending_confirmation or needs_review, clearly say staff must confirm or review it. Never describe it as final, booked, or resolved.",
    "Changes and cancellations require a connected tool that explicitly supports them. Otherwise record the requested change for staff; never claim the original booking was changed.",
    ...(mode === "requests" ? ["Use create_staff_request for changes, cancellations, general enquiries, or missing details that prevent another action. Never invent required details to make a tool succeed. Automatic booking is not enabled in this mode."] : []),
    "If an action fails, explain that it could not be completed. Offer to save a staff request using an available request tool; if that also fails, say it was not saved and provide the configured business contact. Never claim staff were notified unless delivery is verified.",
  ].join("\n");
}
