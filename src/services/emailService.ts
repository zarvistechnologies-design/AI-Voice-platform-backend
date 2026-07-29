import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { EmailDeliveryModel } from "../models/EmailDelivery.js";

export async function sendTransactionalEmail(input: {
  userId?: string;
  to: string;
  subject: string;
  kind: "verification" | "password-reset" | "security" | "invitation" | "support-case" | "billing" | "contact";
  text: string;
  html?: string;
  replyTo?: string;
}) {
  if (!env.resendApiKey && (!env.emailUser || !env.emailPass)) {
    return EmailDeliveryModel.create({ ...input, status: "preview" });
  }
  try {
    if (env.emailUser && env.emailPass) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: env.emailUser, pass: env.emailPass },
      });
      const result = await transporter.sendMail({
        from: env.emailFrom.includes("noreply@example.com")
          ? "Vozon Website <" + env.emailUser + ">"
          : env.emailFrom,
        to: input.to,
        replyTo: input.replyTo || env.emailUser,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      });
      return EmailDeliveryModel.create({
        ...input,
        status: "sent",
        providerId: result.messageId,
      });
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.resendApiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: env.emailFrom,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) throw new Error(data.message ?? "Email provider returned HTTP " + response.status + ".");
    return EmailDeliveryModel.create({ ...input, status: "sent", providerId: data.id ?? "" });
  } catch (error) {
    await EmailDeliveryModel.create({
      ...input,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
