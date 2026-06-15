import { env } from "../config/env.js";
import { EmailDeliveryModel } from "../models/EmailDelivery.js";

export async function sendTransactionalEmail(input: {
  userId?: string;
  to: string;
  subject: string;
  kind: "verification" | "password-reset" | "security";
  text: string;
}) {
  if (!env.resendApiKey) {
    return EmailDeliveryModel.create({ ...input, status: "preview" });
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.emailFrom, to: [input.to], subject: input.subject, text: input.text }),
    });
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) throw new Error(data.message ?? `Email provider returned HTTP ${response.status}.`);
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
