import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

import { env } from "../config/env.js";
import { CustomerCaseModel } from "../models/CustomerCase.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { HttpError } from "../utils/httpError.js";

const services = new Set([
  "AI Voice Agents",
  "Customer Support Automation",
  "Sales & Lead Qualification",
  "Appointment Booking",
  "Outbound Campaigns",
  "Voice API & Integrations",
  "Enterprise Solution",
  "Other",
]);

function cleanText(value: unknown, maximum: number) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanMultiline(value: unknown, maximum: number) {
  return String(value ?? "").replace(/\r/g, "").trim().slice(0, maximum);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function validatedPhone(value: unknown) {
  const phone = cleanText(value, 30);
  if (!phone) throw new HttpError(400, "Enter your phone number.");
  return phone;
}

function validatedEmail(value: unknown) {
  const email = cleanText(value, 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

function newCaseNumber(type: "service" | "support") {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VZN-${type === "support" ? "SUP" : "LEAD"}-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function submitCustomerCase(request: Request, response: Response) {
  // Invisible honeypot field. Real visitors never see or populate it.
  if (cleanText(request.body.website, 200)) {
    response.status(202).json({ submitted: true });
    return;
  }

  const type = request.body.type === "support" ? "support" : request.body.type === "service" ? "service" : null;
  if (!type) throw new HttpError(400, "Choose service enquiry or customer support.");
  const name = cleanText(request.body.name, 80);
  if (name.length < 2) throw new HttpError(400, "Enter your name.");
  const phone = validatedPhone(request.body.phone);
  const email = validatedEmail(request.body.email);
  const company = cleanText(request.body.company, 120);
  const service = type === "service" ? cleanText(request.body.service, 80) : "Customer Support";
  if (type === "service" && !services.has(service)) throw new HttpError(400, "Choose a valid Vozon service.");
  const message = cleanMultiline(request.body.message, 2000);
  if (message.length < 10) throw new HttpError(400, type === "support" ? "Describe the issue in a little more detail." : "Tell us briefly what you want to build.");
  const caseNumber = newCaseNumber(type);

  const customerCase = await CustomerCaseModel.create({
    caseNumber,
    type,
    name,
    phone,
    email,
    company,
    service,
    message,
    sourcePage: cleanText(request.body.sourcePage, 300),
    requestIp: request.ip ?? "",
    userAgent: cleanText(request.headers["user-agent"], 500),
  });

  const typeLabel = type === "support" ? "Support case" : "Sales lead";
  const subject = `[${caseNumber}] New Vozon ${typeLabel}: ${name}`;
  const lines = [
    `${typeLabel} received from Aarohi`,
    `Case: ${caseNumber}`,
    `Name: ${name}`,
    `Phone: ${phone}`,
    `Email: ${email || "Not provided"}`,
    `Company: ${company || "Not provided"}`,
    `Service: ${service}`,
    "",
    message,
  ];
  const html = `<!doctype html><html><body style="margin:0;background:#eef7f5;font-family:Arial,sans-serif;color:#10201e"><div style="max-width:680px;margin:32px auto;background:#fff;border:1px solid #d8e9e5;border-radius:20px;overflow:hidden"><div style="padding:24px 30px;background:#061b18;color:#fff"><div style="font-size:12px;color:#70f5e5;text-transform:uppercase;letter-spacing:2px">Aarohi · Vozon Concierge</div><h1 style="margin:10px 0 0;font-size:23px">${escapeHtml(typeLabel)}</h1></div><div style="padding:30px"><div style="padding:18px;border-radius:14px;background:#effaf7"><strong>${escapeHtml(caseNumber)}</strong><table style="width:100%;margin-top:14px;font-size:14px"><tr><td style="padding:6px;color:#60716d">Name</td><td style="padding:6px;font-weight:bold">${escapeHtml(name)}</td></tr><tr><td style="padding:6px;color:#60716d">Phone</td><td style="padding:6px;font-weight:bold"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td></tr><tr><td style="padding:6px;color:#60716d">Email</td><td style="padding:6px;font-weight:bold">${escapeHtml(email || "Not provided")}</td></tr><tr><td style="padding:6px;color:#60716d">Company</td><td style="padding:6px;font-weight:bold">${escapeHtml(company || "Not provided")}</td></tr><tr><td style="padding:6px;color:#60716d">Service</td><td style="padding:6px;font-weight:bold">${escapeHtml(service)}</td></tr></table></div><h2 style="margin:26px 0 10px;font-size:16px">Visitor message</h2><div style="white-space:pre-wrap;line-height:1.7;padding:18px;border-left:3px solid #16b8a4;background:#f8fbfa">${escapeHtml(message)}</div><p style="margin:26px 0 0;color:#6a7a76;font-size:12px">Submitted from ${escapeHtml(cleanText(request.body.sourcePage, 300) || "the Vozon website")}.</p></div></div></body></html>`;

  try {
    const delivery = await sendTransactionalEmail({
      to: env.supportInbox,
      subject,
      kind: "support-case",
      text: lines.join("\n"),
      html,
    });
    customerCase.emailStatus = delivery.status;
    customerCase.emailDeliveryId = delivery._id;
    await customerCase.save();
  } catch {
    customerCase.emailStatus = "failed";
    await customerCase.save();
    throw new HttpError(502, "Your case was saved, but email delivery failed. Please quote the case number when contacting us.");
  }

  response.status(201).json({
    submitted: true,
    caseNumber,
    message: type === "support"
      ? "Your support case is with the Vozon team."
      : "Your requirements are with our solutions team.",
  });
}


