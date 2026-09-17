import { CallDetailRecordModel, type CallDetailRecord } from "../models/CallDetailRecord.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import { sendTransactionalEmail } from "./emailService.js";
import { productNameForOrganization } from "./whiteLabelService.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function extractCallerName(call: CallDetailRecord): string {
  if (call.callbackDetails?.callerName) {
    return call.callbackDetails.callerName.trim();
  }
  const structured = call.structuredOutput && typeof call.structuredOutput === "object"
    ? (call.structuredOutput as Record<string, unknown>)
    : {};
  const structuredName = String(
    structured.caller_name ?? structured.callerName ?? structured.customer_name ?? structured.name ?? "",
  ).trim();
  if (structuredName) return structuredName;

  for (const item of call.transcript ?? []) {
    if (item.role === "user") {
      const match = item.text.match(/\b(?:my name is|this is|i am|i'm|mera naam|naam hai|mai|main)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s.'-]{1,60})/i);
      if (match?.[1]) {
        const cleaned = match[1].replace(/\b(?:hai|hu|bol raha|bol rahi|here)\b/gi, "").trim();
        if (cleaned) return cleaned;
      }
    }
  }
  return "";
}

function extractCallbackPhone(call: CallDetailRecord): string {
  if (call.callbackDetails?.callbackNumber) {
    return call.callbackDetails.callbackNumber.trim();
  }
  if (call.callerNumber) return call.callerNumber.trim();
  if (call.calledNumber) return call.calledNumber.trim();

  const structured = call.structuredOutput && typeof call.structuredOutput === "object"
    ? (call.structuredOutput as Record<string, unknown>)
    : {};
  const structuredPhone = String(structured.phone ?? structured.callback_number ?? "").trim();
  if (structuredPhone) return structuredPhone;

  for (const item of call.transcript ?? []) {
    const match = item.text.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractCallbackReason(call: CallDetailRecord): string {
  if (call.callbackDetails?.reason) {
    return call.callbackDetails.reason.trim();
  }
  const structured = call.structuredOutput && typeof call.structuredOutput === "object"
    ? (call.structuredOutput as Record<string, unknown>)
    : {};
  const structuredReason = String(
    structured.reason ?? structured.notes ?? structured.intent ?? structured.inquiry ?? "",
  ).trim();
  if (structuredReason) return structuredReason;
  if (call.endReason && !["completed", "agent_ended_call"].includes(call.endReason)) {
    return call.endReason;
  }
  return "Caller requested a callback during the conversation.";
}

function extractPreferredTime(call: CallDetailRecord): string {
  if (call.callbackDetails?.preferredTime) {
    return call.callbackDetails.preferredTime.trim();
  }
  const structured = call.structuredOutput && typeof call.structuredOutput === "object"
    ? (call.structuredOutput as Record<string, unknown>)
    : {};
  const structuredTime = String(
    structured.preferred_time ?? structured.preferredTime ?? structured.callback_time ?? structured.time ?? "",
  ).trim();
  if (structuredTime) return structuredTime;
  return "As soon as possible";
}

function shouldSendCallbackEmail(call: CallDetailRecord, agent: VoiceAgentDocument | null): boolean {
  if (!agent?.callbackEmail) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(agent.callbackEmail)) return false;

  // 1. Explicit tool or flag triggered during call
  if (call.callbackRequested) return true;

  // 2. Structured output outcome or disposition indicating follow-up/callback
  const structured = call.structuredOutput && typeof call.structuredOutput === "object"
    ? (call.structuredOutput as Record<string, unknown>)
    : {};
  const outcome = String(structured.outcome ?? structured.disposition ?? structured.status ?? "").toLowerCase();
  if (outcome.includes("callback") || outcome.includes("follow_up") || outcome.includes("needs_callback")) {
    return true;
  }

  // 3. Tags indicating callback
  if (call.tags?.some((t) => typeof t === "string" && (t.toLowerCase().includes("callback") || t.toLowerCase().includes("follow-up")))) {
    return true;
  }

  // 4. Transcript keyword check for callback requests
  const fullTranscript = (call.transcript ?? []).map((t) => t.text).join(" ").toLowerCase();
  const callbackPatterns = [
    /\b(?:call\s*(?:me\s*)?back|give\s*me\s*a\s*call|have\s*someone\s*call|request(?:ed)?\s*a?\s*callback)\b/i,
    /\b(?:schedule\s*a?\s*callback|reach\s*back\s*out|call\s*again\s*later)\b/i,
    /\b(?:call|phone|baat)\s*(?:karne|karwa|kara|kijiye|karna|laga)\s*(?:ke\s*liye|ko|dijiye|dena|kahiye|bolo|boliye)\b/i,
    /\b(?:mujhe|mujhko|hume|humko)\s*(?:call|phone)\s*(?:karne|kare|kijiye|karwa|karwao)\b/i,
    /\b(?:baad\s*me|dobara|phir\s*se)\s*(?:call|phone)\b/i,
    /\b(?:वापस\s*कॉल|कॉल\s*करने\s*के\s*लिए|कॉल\s*बैक)\b/i,
  ];
  if (callbackPatterns.some((pattern) => pattern.test(fullTranscript))) {
    return true;
  }

  return false;
}

export async function sendCallbackNotificationEmail(callId: string): Promise<{
  success: boolean;
  status: "sent" | "failed" | "skipped";
  reason?: string;
}> {
  try {
    const call = await CallDetailRecordModel.findById(callId);
    if (!call) {
      return { success: false, status: "skipped", reason: "call_not_found" };
    }

    if (call.callbackEmailStatus === "sent") {
      return { success: true, status: "skipped", reason: "already_sent" };
    }

    const agent = await VoiceAgentModel.findById(call.agentId);
    if (!agent || !agent.callbackEmail?.trim()) {
      if (call.callbackRequested && call.callbackEmailStatus !== "skipped") {
        await CallDetailRecordModel.updateOne(
          { _id: call._id },
          { $set: { callbackEmailStatus: "skipped" } },
        );
      }
      return { success: false, status: "skipped", reason: "no_callback_email_configured" };
    }

    const isEligible = shouldSendCallbackEmail(call, agent);
    if (!isEligible) {
      return { success: false, status: "skipped", reason: "callback_criteria_not_met" };
    }

    const recipientEmail = agent.callbackEmail.trim();
    const callerName = extractCallerName(call) || "Caller";
    const callbackPhone = extractCallbackPhone(call) || "Not provided";
    const preferredTime = extractPreferredTime(call);
    const reason = extractCallbackReason(call);
    const duration = formatDuration(call.durationSeconds ?? 0);
    const direction = call.direction ? call.direction.toUpperCase() : "INBOUND";
    const sentiment = call.sentimentLabel
      ? call.sentimentLabel.charAt(0).toUpperCase() + call.sentimentLabel.slice(1)
      : "Neutral";
    const callDate = call.startedAt
      ? new Date(call.startedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC"
      : new Date().toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";

    const transcriptItems = call.transcript ?? [];
    const plainTranscript = transcriptItems.length
      ? transcriptItems.map((item) => `${item.role === "assistant" ? agent.name : "Caller"}: ${item.text}`).join("\n")
      : "No transcript recorded for this call.";

    const htmlTranscript = transcriptItems.length
      ? transcriptItems
          .map((item) => {
            const isAssistant = item.role === "assistant";
            const speakerName = isAssistant ? escapeHtml(agent.name) : "Caller";
            const bg = isAssistant ? "#f0fdf4" : "#f8fafc";
            const border = isAssistant ? "#86efac" : "#cbd5e1";
            const color = isAssistant ? "#166534" : "#1e293b";
            return `<div style="margin-bottom:8px;padding:10px 14px;border-radius:10px;background:${bg};border-left:3px solid ${border}">
              <div style="font-size:11px;font-weight:bold;color:${color};text-transform:uppercase;margin-bottom:3px">${speakerName}</div>
              <div style="font-size:13px;line-height:1.5;color:#1e293b">${escapeHtml(item.text)}</div>
            </div>`;
          })
          .join("")
      : '<p style="color:#64748b;font-style:italic">No transcript recorded for this call.</p>';

    const productName = await productNameForOrganization(call.ownerId, "Vozon");
    const subject = `[Callback Request] ${callerName} (${callbackPhone}) — ${agent.name}`;

    const textContent = [
      `*** ${productName} — Callback Request ***`,
      "",
      `A caller has requested a callback from ${agent.name}.`,
      "",
      "--- CALLER CONTACT DETAILS ---",
      `Name: ${callerName}`,
      `Callback Phone: ${callbackPhone}`,
      `Preferred Time: ${preferredTime}`,
      `Reason / Inquiry: ${reason}`,
      "",
      "--- CALL DETAILS ---",
      `Agent: ${agent.name}`,
      `Direction: ${direction}`,
      `Duration: ${duration}`,
      `Date & Time: ${callDate}`,
      `Sentiment: ${sentiment}`,
      `Call ID: ${String(call._id)}`,
      "",
      "--- CALL TRANSCRIPT ---",
      plainTranscript,
      "",
      `This is an automated notification sent from ${productName}.`,
    ].join("\n");

    const htmlContent = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:28px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06)">
    <!-- Header -->
    <div style="padding:24px 30px;background:#061b18;color:#ffffff">
      <div style="font-size:11px;font-weight:700;color:#70f5e5;text-transform:uppercase;letter-spacing:2px">
        ${escapeHtml(productName)} · Voice Agent Callback
      </div>
      <h1 style="margin:10px 0 4px;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3">
        Callback Request: ${escapeHtml(callerName)}
      </h1>
      <p style="margin:0;font-size:13px;color:#94a3b8">
        Agent: <strong>${escapeHtml(agent.name)}</strong> · ${escapeHtml(callDate)}
      </p>
    </div>

    <div style="padding:28px 30px">
      <!-- Contact Card -->
      <div style="background:#effaf7;border:1px solid #c7ece3;border-radius:14px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#0e6f62;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">
          Caller Information
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr>
            <td style="padding:6px 0;color:#64748b;width:130px;vertical-align:top">Name</td>
            <td style="padding:6px 0;font-weight:600;color:#0f172a">${escapeHtml(callerName)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;vertical-align:top">Callback Phone</td>
            <td style="padding:6px 0;font-weight:700;color:#0e6f62">
              <a href="tel:${escapeHtml(callbackPhone)}" style="color:#0e6f62;text-decoration:none;border-bottom:1px dashed #0e6f62">
                ${escapeHtml(callbackPhone)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;vertical-align:top">Preferred Time</td>
            <td style="padding:6px 0;font-weight:600;color:#0f172a">${escapeHtml(preferredTime)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;vertical-align:top">Reason / Notes</td>
            <td style="padding:6px 0;color:#334155;line-height:1.5">${escapeHtml(reason)}</td>
          </tr>
        </table>
      </div>

      <!-- Call Metrics -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12px">
          <tr style="background:#f8fafc">
            <td style="padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;width:33%">
              <div style="color:#64748b;font-size:11px;text-transform:uppercase;margin-bottom:2px">Duration</div>
              <strong style="color:#0f172a;font-size:14px">${escapeHtml(duration)}</strong>
            </td>
            <td style="padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;width:33%">
              <div style="color:#64748b;font-size:11px;text-transform:uppercase;margin-bottom:2px">Direction</div>
              <strong style="color:#0f172a;font-size:14px">${escapeHtml(direction)}</strong>
            </td>
            <td style="padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;width:33%">
              <div style="color:#64748b;font-size:11px;text-transform:uppercase;margin-bottom:2px">Sentiment</div>
              <strong style="color:#0f172a;font-size:14px">${escapeHtml(sentiment)}</strong>
            </td>
          </tr>
        </table>
      </div>

      <!-- Transcript Section -->
      <div style="margin-bottom:24px">
        <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
          <span>Call Transcript</span>
        </div>
        <div style="max-height:360px;overflow-y:auto;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px">
          ${htmlTranscript}
        </div>
      </div>

      <!-- Action Button -->
      <div style="text-align:center;padding-top:8px;margin-bottom:12px">
        <a href="tel:${escapeHtml(callbackPhone)}" style="display:inline-block;padding:12px 28px;background:#0e6f62;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 6px rgba(14,111,98,0.25)">
          Call ${escapeHtml(callbackPhone)} Now
        </a>
      </div>

      <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px">
        Call ID: <code style="font-size:10px;background:#f1f5f9;padding:2px 6px;border-radius:4px">${escapeHtml(String(call._id))}</code>
        &middot; Automated delivery from ${escapeHtml(productName)}
      </div>
    </div>
  </div>
</body>
</html>`;

    await sendTransactionalEmail({
      userId: call.ownerId,
      to: recipientEmail,
      subject,
      kind: "callback",
      text: textContent,
      html: htmlContent,
    });

    await CallDetailRecordModel.updateOne(
      { _id: call._id },
      {
        $set: {
          callbackRequested: true,
          callbackEmailStatus: "sent",
          callbackEmailSentAt: new Date(),
          ...(call.callbackDetails?.callbackNumber ? {} : {
            "callbackDetails.callerName": callerName,
            "callbackDetails.callbackNumber": callbackPhone,
            "callbackDetails.preferredTime": preferredTime,
            "callbackDetails.reason": reason,
            "callbackDetails.requestedAt": new Date(),
          }),
        },
      },
    );

    console.log(JSON.stringify({
      event: "callback-email-sent",
      callId: String(call._id),
      recipient: recipientEmail,
      callerName,
      callbackPhone,
    }));

    return { success: true, status: "sent" };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "callback-email-failed",
      callId,
      error: errorMsg,
    }));

    await CallDetailRecordModel.updateOne(
      { _id: callId },
      {
        $set: {
          callbackEmailStatus: "failed",
        },
      },
    ).catch(() => undefined);

    return { success: false, status: "failed", reason: errorMsg };
  }
}
