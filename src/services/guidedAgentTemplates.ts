import { HttpError } from "../utils/httpError.js";

export type GuidedIntegrationMode = "native" | "collect" | "external" | "digitalbot";
export type GuidedQuestion = { id: string; label: string; hint: string; required: boolean };
export type GuidedTemplate = {
  id: string;
  name: string;
  team: string;
  description: string;
  goal: string;
  greeting: string;
  collect: string;
  action: string;
  boundary: string;
  outcomeFields: { key: string; label: string; description: string }[];
  questions: GuidedQuestion[];
};

const question = (id: string, label: string, hint = "", required = true): GuidedQuestion => ({ id, label, hint, required });
const common = [
  question("businessName", "Business name", "The name callers should hear."),
  question("businessHours", "Opening hours and timezone", "Example: Mon–Sat, 9 AM–6 PM, Asia/Kolkata."),
  question("handoff", "When should a person take over?", "Example: urgent requests or a caller asking for staff."),
];

export const guidedAgentTemplates: GuidedTemplate[] = [
  {
    id: "restaurant_reservations", name: "Restaurant Reservation Agent", team: "Reservations",
    description: "Handle table enquiries, reservation requests, changes, and cancellations.",
    goal: "Help callers request, change, or cancel a restaurant reservation.",
    greeting: "Hello, thank you for calling {business}. How can I help with your reservation?",
    collect: "name, phone number, date, time, party size, and any important seating or dietary request",
    action: "Check table availability before offering a slot; create or update the reservation only after the caller confirms the details.",
    boundary: "Do not promise a table that has not been confirmed by the booking system.",
    outcomeFields: [
      { key: "reservation_time", label: "Reservation time", description: "Requested or confirmed date and time" },
      { key: "party_size", label: "Party size", description: "Number of guests" },
      { key: "booking_reference", label: "Booking reference", description: "Reference returned by the booking tool" },
    ],
    questions: [...common, question("bookingRules", "Reservation rules", "Maximum group size, lead time, cancellation policy."), question("specialRequests", "Special requests to collect", "Examples: high chair, allergies, outdoor seating.", false)],
  },
  {
    id: "clinic_appointments", name: "Clinic Appointment Agent", team: "Appointments",
    description: "Book or change appointments and route medical concerns to clinic staff.",
    goal: "Help callers request, reschedule, or cancel a clinic appointment.",
    greeting: "Hello, you have reached {business}. How can I help with an appointment?",
    collect: "patient name, callback number, requested doctor or specialty, appointment type, and preferred date and time",
    action: "Check appointment availability before offering a slot; create or change an appointment only after the caller confirms the details.",
    boundary: "Do not diagnose, prescribe, or give treatment advice. Direct emergencies to local emergency services and transfer medical questions to qualified staff.",
    outcomeFields: [
      { key: "appointment_time", label: "Appointment time", description: "Requested or confirmed date and time" },
      { key: "provider_name", label: "Doctor or provider", description: "Requested clinician or specialty" },
      { key: "booking_reference", label: "Booking reference", description: "Reference returned by the booking tool" },
    ],
    questions: [
      question("businessName", "Clinic name", "The name callers should hear."),
      question("providers", "Doctors or providers", "Comma-separated names, for example: Dr Mehta, Dr Shah."),
      question("appointmentTimezone", "Booking timezone", "IANA timezone, for example Asia/Kolkata."),
      question("bookingDays", "Booking days", "Example: Mon,Tue,Wed,Thu,Fri,Sat."),
      question("bookingStart", "First appointment time", "24-hour time, for example 09:00."),
      question("bookingEnd", "Clinic closing time", "24-hour time, for example 17:00."),
      question("appointmentDuration", "Appointment duration in minutes", "Example: 30."),
      question("businessHours", "Opening hours callers should hear", "Example: Mon-Sat, 9 AM-5 PM."),
      question("clinicRules", "Appointment and cancellation rules", "Include any preparation that must be mentioned."),
      question("handoff", "When should clinic staff take over?", "Example: emergencies, medical questions, or caller requests staff."),
    ],
  },
  {
    id: "hotel_reservations", name: "Hotel Reservation Agent", team: "Reservations",
    description: "Qualify room enquiries and confirm bookings through a connected system.",
    goal: "Help guests enquire about, create, change, or cancel room reservations.",
    greeting: "Hello, thank you for calling {business}. How can I help with your stay?",
    collect: "guest name, phone number, check-in and checkout dates, number of guests, and room preference",
    action: "Check live room availability and rate before offering a room; create a booking only after the guest confirms the terms.",
    boundary: "Do not invent room availability, prices, taxes, or cancellation terms.",
    outcomeFields: [
      { key: "stay_dates", label: "Stay dates", description: "Check-in and checkout dates" },
      { key: "room_type", label: "Room type", description: "Requested or confirmed room" },
      { key: "booking_reference", label: "Booking reference", description: "Reference returned by the booking tool" },
    ],
    questions: [...common, question("roomTypes", "Room types and important amenities", "Put full rates and inventory in your booking system."), question("hotelRules", "Check-in and cancellation rules", "Brief rules the agent should mention.")],
  },
  {
    id: "real_estate_qualification", name: "Real Estate Qualification Agent", team: "Sales",
    description: "Qualify property enquiries and arrange a verified site visit.",
    goal: "Understand property needs and prepare a qualified lead or site-visit request.",
    greeting: "Hello, thank you for calling {business}. What kind of property are you looking for?",
    collect: "name, phone number, preferred location, property type, budget, purchase timeline, and site-visit preference",
    action: "Use connected property data for availability and schedule a site visit only after the caller accepts a verified slot.",
    boundary: "Do not guarantee property availability, investment returns, financing approval, or a site visit without confirmation.",
    outcomeFields: [
      { key: "location", label: "Preferred location", description: "Location or project of interest" },
      { key: "budget", label: "Budget", description: "Approximate purchase budget" },
      { key: "visit_time", label: "Site visit time", description: "Requested or confirmed visit" },
    ],
    questions: [...common, question("markets", "Locations and property types served", "Keep detailed inventory in your CRM or knowledge base."), question("qualification", "Qualification questions", "Example: financing, intended use, and decision timeline.")],
  },
  {
    id: "service_booking", name: "Service Booking Agent", team: "Bookings",
    description: "Collect service needs and arrange a technician or staff appointment.",
    goal: "Help callers request, change, or cancel a service booking.",
    greeting: "Hello, you have reached {business}. What service can I help you arrange?",
    collect: "name, phone number, service needed, service location, issue details, and preferred date and time",
    action: "Check service-area and staff availability before offering a time; book only after the caller confirms the details.",
    boundary: "Do not guarantee a technician, final price, or appointment until the connected system confirms it.",
    outcomeFields: [
      { key: "service_type", label: "Service type", description: "Requested service" },
      { key: "service_location", label: "Service location", description: "Where service is needed" },
      { key: "booking_reference", label: "Booking reference", description: "Reference returned by the booking tool" },
    ],
    questions: [...common, question("services", "Services and service areas", "List the common services and places you cover."), question("serviceRules", "Pricing and booking rules", "Mention estimates, travel fees, and cancellation terms.")],
  },
  {
    id: "payment_reminders", name: "Payment Reminder Agent", team: "Billing",
    description: "Discuss approved invoices, send payment options, and record disputes.",
    goal: "Remind the intended customer about an approved outstanding invoice and record the next step.",
    greeting: "Hello, this is {business} calling about an account matter. Is now a good time to speak?",
    collect: "recipient identity confirmation, invoice reference, payment intent, promised payment date, dispute reason, and callback preference",
    action: "Look up an invoice and payment status through connected tools before stating an amount or marking it paid.",
    boundary: "Do not disclose debt to another person, request card credentials, threaten the caller, or claim a payment succeeded without a verified payment result. Respect opt-outs and disputes.",
    outcomeFields: [
      { key: "invoice_reference", label: "Invoice reference", description: "Invoice discussed" },
      { key: "promise_date", label: "Promise-to-pay date", description: "Date stated by the customer" },
      { key: "dispute_reason", label: "Dispute reason", description: "Reason for disagreement, if any" },
    ],
    questions: [...common, question("verification", "How should the recipient be verified?", "Use approved identity checks; never ask for passwords or card data."), question("paymentOptions", "Approved payment options and dispute route", "Keep amounts and invoice records in the billing system.")],
  },
  {
    id: "customer_feedback", name: "Customer Feedback Agent", team: "Customer Experience",
    description: "Collect ratings and comments, then flag unhappy customers for follow-up.",
    goal: "Collect useful, voluntary feedback about a recent experience.",
    greeting: "Hello, this is {business}. May I ask a few brief questions about your recent experience?",
    collect: "overall rating, what worked, what did not, resolution request, and permission for a follow-up",
    action: "Record a support request through a connected tool only when the caller asks for help and the tool confirms it.",
    boundary: "Do not pressure the caller to give a positive rating or promise a refund or resolution that has not been approved.",
    outcomeFields: [
      { key: "rating", label: "Rating", description: "Customer's stated rating" },
      { key: "feedback_theme", label: "Feedback theme", description: "Main compliment or complaint" },
      { key: "follow_up_requested", label: "Follow-up requested", description: "Whether a human response was requested" },
    ],
    questions: [...common, question("feedbackTopic", "What experience should be reviewed?", "Example: a recent visit, order, or service call."), question("escalationThreshold", "When should negative feedback be escalated?", "Example: rating 2/5 or below, safety complaint, refund request.")],
  },
];

export function guidedTemplateById(id: string) {
  return guidedAgentTemplates.find((template) => template.id === id);
}

export function assertGuidedIntegrationReady(
  mode: GuidedIntegrationMode,
  tools: { enabled?: boolean; managedBy?: string }[],
) {
  if (mode === "external" && !tools.some((tool) => tool.enabled !== false && tool.managedBy !== "digitalbot")) {
    throw new HttpError(409, "Connect and enable a business API tool before publishing this agent, or create a collect-only agent.");
  }
  if (mode === "digitalbot" && !tools.some((tool) => tool.enabled !== false && tool.managedBy === "digitalbot")) {
    throw new HttpError(409, "Connect DigitalBot and attach its tools before publishing this agent.");
  }
  if (mode === "native" && !tools.some((tool) => tool.enabled !== false && tool.managedBy === "vozon")) {
    throw new HttpError(409, "Restore the Vozon managed tools before publishing this agent.");
  }
}

function answerText(value: unknown, max = 300) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function buildGuidedAgent(input: {
  templateId: string;
  answers: Record<string, unknown>;
  mode: GuidedIntegrationMode;
  language?: unknown;
  name?: unknown;
  promptOverride?: unknown;
}) {
  const template = guidedTemplateById(input.templateId);
  if (!template) throw new HttpError(404, "Agent template not found.");
  if (!["native", "collect", "external", "digitalbot"].includes(input.mode)) throw new HttpError(400, "Choose where business results should go.");
  const answers = Object.fromEntries(template.questions.map(({ id }) => [id, answerText(input.answers?.[id])]));
  const missing = template.questions.find(({ id, required }) => required && !answers[id]);
  if (missing) throw new HttpError(400, `${missing.label} is required.`);
  if (input.mode === "native" && template.id === "clinic_appointments") nativeClinicConfig(answers);
  const business = answers.businessName;
  const language = answerText(input.language, 60) || "English";
  const name = answerText(input.name, 80) || `${business} ${template.name}`.slice(0, 80);
  const operationalNotes = template.questions
    .filter(({ id }) => !["businessName", "businessHours", "handoff"].includes(id) && answers[id])
    .map(({ label, id }) => `${label}: ${answers[id]}.`);
  const nativeRules: Record<string, string> = {
    clinic_appointments: "Use check_appointment_availability before offering times. Book only with the exact slotId returned by that tool, after the caller confirms the doctor, date, and time. Collect the patient name and phone number, then call book_appointment. Say the appointment is confirmed only when it returns success and a booking reference.",
    restaurant_reservations: "After repeating the reservation details, use create_restaurant_reservation_request. Tell the caller the request was recorded and staff must confirm table availability; never call it a confirmed reservation.",
    hotel_reservations: "After repeating the stay details, use create_hotel_booking_request. Tell the caller the request was recorded and staff must confirm room availability, rate, taxes, and payment; never call it a confirmed booking.",
    real_estate_qualification: "Use save_qualified_property_lead after collecting the lead criteria. Use create_site_visit_request only after confirming the preferred visit details, and tell the caller staff must confirm the visit.",
    service_booking: "After repeating the service details, use create_service_booking_request. Tell the caller staff must confirm technician availability and the final price.",
    payment_reminders: "Use record_payment_promise for a promised payment date or record_payment_dispute for a dispute. These tools never take payment, change a balance, or mark an invoice paid.",
    customer_feedback: "Use record_customer_feedback after the caller agrees to provide feedback. Use create_customer_follow_up when the caller asks for help or the escalation threshold is met.",
  };
  const modeRule = input.mode === "native"
    ? nativeRules[template.id]
    : input.mode === "collect"
    ? "Collect the request and summarize it for staff review. No booking, payment, or action is confirmed in this mode. Tell the caller staff must confirm it."
    : "Use a connected action tool only when it is configured and enabled. Confirm a booking, payment, or change only after the tool returns success and a reference. If no tool is connected or it fails, collect the request and say staff must confirm it.";
  const nativeActions: Record<string, string> = {
    restaurant_reservations: "Record the confirmed request with create_restaurant_reservation_request. Table availability still requires staff confirmation.",
    clinic_appointments: template.action,
    hotel_reservations: "Record the confirmed request with create_hotel_booking_request. Room inventory, rate, taxes, and payment still require staff confirmation.",
    real_estate_qualification: "Save qualified leads with save_qualified_property_lead and requested visits with create_site_visit_request. Staff must confirm a visit slot.",
    service_booking: "Record the service request with create_service_booking_request. Staff must confirm technician availability and final price.",
    payment_reminders: "Record a promise with record_payment_promise or a dispute with record_payment_dispute. Never mark an invoice paid.",
    customer_feedback: "Store feedback with record_customer_feedback and create a follow-up item with create_customer_follow_up when required.",
  };
  const generatedPrompt = [
    `You are the ${template.name} for ${business}. Speak ${language} naturally and keep replies brief. Ask one question at a time.`,
    `Goal: ${template.goal}`,
    `Collect: ${template.collect}. Repeat key details before taking action.`,
    `Business hours: ${answers.businessHours}.`,
    ...operationalNotes,
    input.mode === "collect"
      ? "Action: Record the requested next step and key details for staff review; do not attempt to book, update, or take payment."
      : `Action: ${input.mode === "native" ? nativeActions[template.id] : template.action}`,
    modeRule,
    `Handoff: ${answers.handoff}.`,
    `Boundary: ${template.boundary}`,
    "Never invent availability, prices, policies, or tool results. If unsure, ask for clarification or offer staff follow-up.",
  ].join("\n");
  const promptOverride = typeof input.promptOverride === "string" ? input.promptOverride.trim() : "";
  if (promptOverride.length > 5000) throw new HttpError(400, "Guided prompt must be 5,000 characters or fewer.");
  const prompt = promptOverride || generatedPrompt;
  const firstMessage = template.greeting.replace("{business}", business);
  return { template, name, language, prompt, firstMessage, answers, mode: input.mode, generatedPrompt };
}

const weekdayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function nativeClinicConfig(answers: Record<string, string>) {
  const providers = (answers.providers ?? "").split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 30);
  if (!providers.length) throw new HttpError(400, "Add at least one doctor or provider.");
  const timezone = (answers.appointmentTimezone ?? "").trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new HttpError(400, "Use a valid IANA booking timezone, such as Asia/Kolkata."); }
  const weekdays = (answers.bookingDays ?? "").split(/[,;\s]+/)
    .map((value) => weekdayMap[value.trim().toLowerCase().slice(0, 3)])
    .filter((value): value is number => Number.isInteger(value));
  if (!weekdays.length) throw new HttpError(400, "Add valid booking days such as Mon,Tue,Wed,Thu,Fri.");
  const startTime = (answers.bookingStart ?? "").trim();
  const endTime = (answers.bookingEnd ?? "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || endTime <= startTime) {
    throw new HttpError(400, "Use valid 24-hour booking times, with closing time after opening time.");
  }
  const durationMinutes = Number(answers.appointmentDuration);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240) {
    throw new HttpError(400, "Appointment duration must be between 5 and 240 minutes.");
  }
  return { enabled: true, timezone, durationMinutes, providers, weekdays: [...new Set(weekdays)], startTime, endTime };
}
