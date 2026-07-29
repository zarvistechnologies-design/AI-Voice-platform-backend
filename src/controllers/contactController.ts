import type { Request, Response } from "express";

import { env } from "../config/env.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { HttpError } from "../utils/httpError.js";

const inquiryTypes = new Set([
  "Product demo",
  "Enterprise rollout",
  "Pricing and plans",
  "Partnership",
  "Other",
]);

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const submissionWindowMs = 15 * 60 * 1000;
const maxSubmissionsPerWindow = 5;
const submissionsByIp = new Map<string, number[]>();

function cleanString(value: unknown, field: string, maxLength: number, required = true) {
  if (typeof value !== "string") {
    if (!required && value == null) return "";
    throw new HttpError(400, `${field} is required.`);
  }

  const cleaned = value.trim();
  if (required && !cleaned) throw new HttpError(400, `${field} is required.`);
  if (cleaned.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`);
  }
  return cleaned;
}

function enforceSubmissionLimit(request: Request) {
  const now = Date.now();
  const key = request.ip || request.socket.remoteAddress || "unknown";
  const recent = (submissionsByIp.get(key) ?? []).filter(
    (submittedAt) => now - submittedAt < submissionWindowMs,
  );

  if (recent.length >= maxSubmissionsPerWindow) {
    throw new HttpError(429, "Too many messages sent. Please wait a few minutes and try again.");
  }

  recent.push(now);
  submissionsByIp.set(key, recent);

  if (submissionsByIp.size > 1_000) {
    for (const [ip, timestamps] of submissionsByIp) {
      if (!timestamps.some((submittedAt) => now - submittedAt < submissionWindowMs)) {
        submissionsByIp.delete(ip);
      }
    }
  }
}

export async function submitContactRequest(request: Request, response: Response) {
  const website = cleanString(request.body?.website, "Website", 200, false);

  // Silently accept submissions that fill the hidden honeypot field.
  if (website) {
    response.status(202).json({ message: "Your message has been received." });
    return;
  }

  enforceSubmissionLimit(request);

  const firstName = cleanString(request.body?.firstName, "First name", 80);
  const lastName = cleanString(request.body?.lastName, "Last name", 80);
  const email = cleanString(request.body?.email, "Work email", 254).toLowerCase();
  const phone = cleanString(request.body?.phone, "Phone number", 40, false);
  const company = cleanString(request.body?.company, "Company", 120);
  const inquiry = cleanString(request.body?.inquiry, "Inquiry type", 80);
  const message = cleanString(request.body?.message, "Message", 4_000);

  if (!emailPattern.test(email)) throw new HttpError(400, "Enter a valid work email.");
  if (!inquiryTypes.has(inquiry)) throw new HttpError(400, "Select a valid inquiry type.");
  if (!env.resendApiKey && (!env.emailUser || !env.emailPass)) {
    throw new HttpError(503, "Email delivery is not configured. Please email hello@vozon.ai directly.");
  }

  const safeCompany = company.replace(/[\r\n]+/g, " ");
  const text = [
    "New vozon.ai contact sales enquiry",
    "",
    `Name: ${firstName} ${lastName}`,
    `Work email: ${email}`,
    `Phone: ${phone || "Not provided"}`,
    `Company: ${company}`,
    `Inquiry type: ${inquiry}`,
    "",
    "Message:",
    message,
  ].join("\n");

  await sendTransactionalEmail({
    to: env.contactEmail,
    subject: `[Contact Sales] ${safeCompany} — ${inquiry}`,
    kind: "contact",
    text,
    replyTo: email,
  });

  response.status(202).json({ message: "Thanks — your message has been sent to our sales team." });
}
