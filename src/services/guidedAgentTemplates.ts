import { HttpError } from "../utils/httpError.js";
import { guidedActionPolicy } from "./guidedActionPolicy.js";

export type GuidedIntegrationMode = "requests" | "native" | "collect" | "external" | "digitalbot";
export type GuidedQuestionControl = "text" | "textarea" | "list" | "handoff" | "business-hours" | "timezone" | "weekdays" | "time" | "duration";
export type GuidedQuestion = {
  id: string;
  label: string;
  hint: string;
  required: boolean;
  requestRequired: boolean;
  control: GuidedQuestionControl;
  options?: string[];
};
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

const question = (
  id: string,
  label: string,
  hint = "",
  required = true,
  control: GuidedQuestionControl = "text",
  options?: string[],
): GuidedQuestion => ({ id, label, hint, required, requestRequired: required && !["handoff", "bookingRules", "clinicRules", "hotelRules", "qualification", "serviceRules", "escalationThreshold"].includes(id), control, ...(options?.length ? { options } : {}) });
const common = [
  question("businessName", "Business name", "The name callers should hear."),
  question("businessHours", "Opening hours and timezone", "Select the working days, opening time, closing time, and timezone.", true, "business-hours"),
  question("handoff", "When should a person take over?", "Select common reasons and add any business-specific rule.", true, "handoff", [
    "The caller asks for a person",
    "The request is urgent",
    "The agent cannot answer confidently",
    "A booking or business tool fails",
  ]),
];

export const guidedAgentTemplates: GuidedTemplate[] = [
  {
    id: "restaurant_reservations", name: "Restaurant Reservation Agent", team: "Reservations",
    description: "Answer restaurant questions and collect reservation requests for your staff.",
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
    questions: [...common, question("bookingRules", "Reservation rules", "Add one rule at a time, such as maximum group size or cancellation policy.", true, "list"), question("specialRequests", "Special requests to collect", "Add options such as high chair, allergies, or outdoor seating.", false, "list")],
  },
  {
    id: "clinic_appointments", name: "Clinic Appointment Agent", team: "Appointments",
    description: "Answer clinic questions and collect appointment requests for your staff.",
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
      question("providers", "Doctors or providers", "Add each doctor, provider, or specialty separately.", true, "list"),
      question("appointmentTimezone", "Booking timezone", "Select the timezone used for appointment slots.", true, "timezone"),
      question("bookingDays", "Booking days", "Select every day when appointments may be booked.", true, "weekdays"),
      question("bookingStart", "First appointment time", "Select the first available appointment time.", true, "time"),
      question("bookingEnd", "Clinic closing time", "Select a closing time after the first appointment time.", true, "time"),
      question("appointmentDuration", "Appointment duration", "Select the standard slot length.", true, "duration"),
      question("businessHours", "Opening hours callers should hear", "Select the public opening days and hours.", true, "business-hours"),
      question("clinicRules", "Appointment and cancellation rules", "Add one booking, cancellation, or preparation rule at a time.", true, "list"),
      question("handoff", "When should clinic staff take over?", "Select common reasons and add any clinic-specific rule.", true, "handoff", [
        "The caller asks for clinic staff",
        "The caller reports an emergency",
        "The caller asks for medical advice",
        "The appointment tool fails",
      ]),
    ],
  },
  {
    id: "hotel_reservations", name: "Hotel Reservation Agent", team: "Reservations",
    description: "Answer hotel questions and collect stay requests for your staff.",
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
    questions: [...common, question("roomTypes", "Room types and important amenities", "Add each room type with its important amenities.", true, "list"), question("hotelRules", "Check-in and cancellation rules", "Add each check-in, cancellation, deposit, or ID rule separately.", true, "list")],
  },
  {
    id: "real_estate_qualification", name: "Real Estate Qualification Agent", team: "Sales",
    description: "Collect property enquiries, buyer details, and site visit requests.",
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
    questions: [...common, question("markets", "Locations and property types served", "Add each location or property category separately.", true, "list"), question("qualification", "Qualification questions", "Add each detail to collect, such as financing or decision timeline.", true, "list")],
  },
  {
    id: "service_booking", name: "Service Booking Agent", team: "Bookings",
    description: "Answer service questions and collect requests with the customer's preferred time.",
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
    questions: [...common, question("services", "Services and service areas", "Add each service or covered area separately.", true, "list"), question("serviceRules", "Pricing and booking rules", "Add each price, estimate, travel fee, or cancellation rule separately.", true, "list")],
  },
  {
    id: "payment_reminders", name: "Payment Reminder Agent", team: "Billing",
    description: "Collect responses to payment reminders, promises to pay, and disputes.",
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
    questions: [...common, question("verification", "How should the recipient be verified?", "Add each approved identity check separately. Never ask for passwords or card data.", true, "list"), question("paymentOptions", "Approved payment options and dispute route", "Add only approved payment channels and dispute routes.", true, "list")],
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
    questions: [...common, question("feedbackTopic", "What experience should be reviewed?", "Add each visit, order, product, or service type separately.", true, "list"), question("escalationThreshold", "When should negative feedback be escalated?", "Add each reason, such as a low rating or safety complaint.", true, "list")],
  },
];

export function guidedTemplateById(id: string) {
  return guidedAgentTemplates.find((template) => template.id === id);
}

export const clinicScheduleFields = ["appointmentTimezone", "bookingDays", "bookingStart", "bookingEnd", "appointmentDuration"];

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
  if ((mode === "native" || mode === "requests") && !tools.some((tool) => tool.enabled !== false && tool.managedBy === "vozon")) {
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
  timezone?: unknown;
  staffPhone?: unknown;
  staffEmail?: unknown;
}) {
  const template = guidedTemplateById(input.templateId);
  if (!template) throw new HttpError(404, "Agent template not found.");
  if (!["requests", "native", "collect", "external", "digitalbot"].includes(input.mode)) throw new HttpError(400, "Choose where business results should go.");
  const questions = template.questions.filter(({ id }) => input.mode !== "requests" || !clinicScheduleFields.includes(id));
  const answers = Object.fromEntries(questions.map(({ id }) => [id, answerText(input.answers?.[id])]));
  if (input.mode === "requests" && !answers.handoff) answers.handoff = "Offer staff help when the caller asks for a person, a request is urgent, or an action fails.";
  const missing = questions.find(({ id, required, requestRequired }) => (input.mode === "requests" ? requestRequired : required) && !answers[id]);
  if (missing) throw new HttpError(400, `${missing.label} is required.`);
  answers.staffPhone = answerText(input.staffPhone, 40);
  answers.staffEmail = answerText(input.staffEmail, 160);
  answers.businessTimezone = answerText(input.timezone, 100) || "Asia/Kolkata";
  if (answers.staffPhone && !/^\+[1-9]\d{7,14}$/.test(answers.staffPhone)) throw new HttpError(400, "Enter the staff phone number with country code, for example +919876543210.");
  if (answers.staffEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.staffEmail)) throw new HttpError(400, "Enter a valid staff email address.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: answers.businessTimezone }).format(new Date()); }
  catch { throw new HttpError(400, "Choose a valid business timezone."); }
  if (input.mode === "native" && template.id === "clinic_appointments") nativeClinicConfig(answers);
  const business = answers.businessName;
  const language = answerText(input.language, 60) || "English";
  const name = answerText(input.name, 80) || `${business} ${template.name}`.slice(0, 80);
  const operationalNotes = template.questions
    .filter(({ id }) => !["businessName", "businessHours", "handoff"].includes(id) && answers[id])
    .map(({ label, id }) => `${label}: ${answers[id]}.`);
  const modeRule = input.mode === "native" || input.mode === "requests"
    ? guidedActionPolicy(template.id, input.mode)
    : input.mode === "collect"
    ? "Collect the request and summarize it for staff review. No booking, payment, or action is confirmed in this mode. Tell the caller staff must confirm it."
    : "Use a connected action tool only when it is configured and enabled. Confirm a booking, payment, or change only after the tool returns success and a reference. If no tool is connected or it fails, collect the request and say staff must confirm it.";
  const generatedPrompt = [
    `You are the ${template.name} for ${business}. Speak ${language} naturally and keep replies brief. Ask one question at a time.`,
    `Goal: ${input.mode === "requests" ? "Answer questions from the supplied business information and save the caller's request or response for staff." : template.goal}`,
    `Collect: ${template.collect}. Repeat key details before taking action.`,
    `Business hours: ${answers.businessHours}.`,
    ...operationalNotes,
    input.mode === "collect"
      ? "Action: Record the requested next step and key details for staff review; do not attempt to book, update, or take payment."
      : `Action: ${input.mode === "native" || input.mode === "requests" ? "Use the action rules below and report exactly what was saved or completed." : template.action}`,
    modeRule,
    `Handoff: ${answers.handoff}.`,
    answers.staffPhone ? `Staff contact: ${answers.staffPhone}. Use transfer_to_human when needed; if transfer fails, offer to record a request. Never promise a response time.` : "No staff transfer number is configured. Offer to record a staff request instead of promising a live transfer.",
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
