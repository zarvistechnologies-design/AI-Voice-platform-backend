/** Shared by generated instructions and runtime so saved prompts cannot overpromise. */
export function guidedActionPolicy(templateId: string, mode: string) {
  if (mode !== "native" && mode !== "requests" && mode !== "google_workspace") return "";
  const rules: Record<string, string> = {
    restaurant_reservations: mode === "google_workspace"
      ? "Use check_google_calendar_availability to check availability before offering a reservation slot. Confirm reservations using book_google_calendar_appointment and collect caller name and phone number. Guest and reservation details are automatically logged into Google Sheets."
      : "Use create_restaurant_reservation to save a table request. It does not check table capacity or reserve a table. Staff must confirm the reservation.",
    clinic_appointments: mode === "google_workspace"
      ? "Use check_google_calendar_availability before offering times. Never promise a time without checking the live Google Calendar. Collect caller name and callback phone number, then book the confirmed slot with book_google_calendar_appointment. State the returned reference clearly. All appointments and caller details are automatically logged into Google Sheets."
      : mode === "native"
      ? "Use check_appointment_availability before offering times. Book only with the exact slotId returned after the caller confirms. Confirm a new appointment only when book_appointment returns success=true, confirmed=true, status=booked, and a bookingReference. This schedule is held in Vozon; do not imply another calendar was updated."
      : "Use create_clinic_appointment_request to save an appointment request. Staff must confirm the doctor and time; no appointment has been booked.",
    hotel_reservations: mode === "google_workspace"
      ? "Collect stay dates, guest details, and room preference. Check availability with check_google_calendar_availability and confirm reservations using book_google_calendar_appointment. Records are saved to Google Sheets."
      : "Use create_hotel_booking to save a stay request. It does not check room inventory or rates or reserve a room. Staff must confirm availability and terms.",
    real_estate_qualification: mode === "google_workspace"
      ? "Collect caller property requirements, budget, and location. For site visit requests, check calendar availability using check_google_calendar_availability and schedule visits with book_google_calendar_appointment. All qualified leads are logged to Google Sheets."
      : "Use save_qualified_property_lead to save the caller's property needs. Use create_site_visit_request for a requested visit; staff must confirm availability and the visit time.",
    service_booking: mode === "google_workspace"
      ? "Use check_google_calendar_availability to check service slot availability. Confirm service bookings using book_google_calendar_appointment and collect caller name and phone number. Bookings and job requests are logged automatically to Google Sheets."
      : "Use create_service_booking to save a service request. It does not check staff availability or service coverage. Staff must confirm the service, price, and appointment.",
    payment_reminders: mode === "google_workspace"
      ? "Record customer payment promises and dispute notes. All updates are logged automatically to Google Sheets for finance staff review."
      : "Use record_payment_promise or record_payment_dispute to save the customer's response. These tools do not verify identity, look up invoices, take payment, change a balance, or resolve disputes. State an amount only from verified business data after the approved identity check.",
    customer_feedback: mode === "google_workspace"
      ? "Collect customer feedback, ratings, and follow-up requests. All records are saved to Google Sheets for staff review."
      : "Use record_customer_feedback to save voluntary feedback and create_customer_follow_up for requested help. A saved follow-up item still needs staff review; it does not resolve the complaint.",
  };
  if (!rules[templateId]) return "";
  return [
    "CURRENT ACTION RULES (take precedence over older booking instructions):",
    rules[templateId],
    "Repeat the key details and get the caller's agreement before saving. Say a request or record was saved only after its tool returns success=true and a reference. A reference alone is not a confirmed booking.",
    "When confirmed=false or status=pending_confirmation or needs_review, clearly say staff must confirm or review it. Never describe it as final, booked, or resolved.",
    "Changes and cancellations require a connected tool that explicitly supports them. Otherwise record the requested change for staff; never claim the original booking was changed.",
    ...(mode === "requests" ? ["Use create_staff_request for changes, cancellations, general enquiries, or missing details that prevent another action. Never invent required details to make a tool succeed. Automatic booking is not enabled in this mode."] : []),
    ...(mode === "google_workspace" ? [
      "Confirm appointments or bookings only when book_google_calendar_appointment returns success=true. State the confirmed reference clearly.",
      "If Google Calendar availability check shows a slot is busy, inform the caller politely and propose the nearest open time.",
    ] : []),
    "If an action fails, explain that it could not be completed. Offer to save a staff request using an available request tool; if that also fails, say it was not saved and provide the configured business contact. Never claim staff were notified unless delivery is verified.",
  ].join("\n");
}
