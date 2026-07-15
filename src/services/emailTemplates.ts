type InvitationRole = "admin" | "member" | "billing";
type EmailTone = "brand" | "success" | "warning";

type EmailDetail = {
  label: string;
  value: string;
};

type EmailAction = {
  label: string;
  url: string;
};

type BrandedEmailInput = {
  documentTitle: string;
  preheader: string;
  eyebrow: string;
  title: string;
  recipientName?: string;
  intro: string;
  details?: EmailDetail[];
  action?: EmailAction;
  supportingText?: string;
  noticeText?: string;
  tone?: EmailTone;
};

export type TransactionalEmailContent = {
  subject: string;
  text: string;
  html: string;
};

const toneColors: Record<EmailTone, { accent: string; soft: string; border: string }> = {
  brand: { accent: "#0a9f8f", soft: "#edf9f7", border: "#ccebe6" },
  success: { accent: "#07875f", soft: "#edf9f3", border: "#cce9dc" },
  warning: { accent: "#b96008", soft: "#fff7e8", border: "#f1d9ae" },
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}

function emailSubject(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeActionUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Email action URL must use HTTP or HTTPS.");
  }
  return url.toString();
}

function roleLabel(role: InvitationRole) {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

function greeting(name?: string) {
  const normalizedName = name?.trim();
  return normalizedName ? `Hi ${normalizedName},` : "Hello,";
}

function formatUtcDate(value: Date) {
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value)} UTC`;
}

function renderBrandedEmail(input: BrandedEmailInput) {
  const tone = toneColors[input.tone ?? "brand"];
  const action = input.action
    ? { label: escapeHtml(input.action.label), url: escapeHtml(safeActionUrl(input.action.url)) }
    : undefined;
  const details = input.details ?? [];
  const currentYear = new Date().getUTCFullYear();
  const detailsHtml = details.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:28px 0;background:${tone.soft};border:1px solid ${tone.border};border-radius:16px;">
        ${details
          .map(
            (detail, index) => `<tr>
          <td style="padding:17px 20px;${index < details.length - 1 ? `border-bottom:1px solid ${tone.border};` : ""}">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td class="detail-label" style="color:#6c7d79;font-size:13px;font-weight:600;">${escapeHtml(detail.label)}</td>
                <td class="detail-value" align="right" style="color:#10201e;font-size:14px;font-weight:800;">${escapeHtml(detail.value)}</td>
              </tr>
            </table>
          </td>
        </tr>`,
          )
          .join("")}
      </table>`
    : "";
  const actionHtml = action
    ? `<a class="email-button" href="${action.url}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 25px;border-radius:12px;background:${tone.accent};color:#ffffff;font-size:15px;font-weight:800;line-height:1;text-decoration:none;box-shadow:0 8px 20px rgba(10,159,143,0.20);">${action.label}&nbsp;&nbsp;→</a>`
    : "";
  const supportingHtml = input.supportingText
    ? `<p style="margin:${action ? "22px" : "24px"} 0 0;color:#6c7d79;font-size:13px;line-height:1.65;">${escapeHtml(input.supportingText)}</p>`
    : "";
  const noticeHtml = input.noticeText
    ? `<div style="margin:28px 0 0;padding:16px 18px;border-radius:13px;background:#f7faf9;border:1px solid #e1ebe8;color:#667773;font-size:12px;line-height:1.65;">${escapeHtml(input.noticeText)}</div>`
    : "";
  const fallbackHtml = action
    ? `<div style="margin:28px 0 0;padding-top:24px;border-top:1px solid #e4edeb;">
        <p style="margin:0 0 8px;color:#7b8b87;font-size:12px;line-height:1.55;">If the button does not work, copy and paste this link into your browser:</p>
        <p style="margin:0;word-break:break-all;color:${tone.accent};font-size:12px;line-height:1.55;"><a href="${action.url}" style="color:${tone.accent};text-decoration:underline;">${action.url}</a></p>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(input.documentTitle)}</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { width: 100% !important; }
        .email-body { padding: 32px 22px !important; }
        .email-header { padding: 22px !important; }
        .email-footer { padding: 22px !important; }
        .email-button { display: block !important; text-align: center !important; }
        .detail-label, .detail-value { display: block !important; width: 100% !important; text-align: left !important; }
        .detail-value { padding-top: 4px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f2f7f6;color:#10201e;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f2f7f6;">
      <tr>
        <td align="center" style="padding:36px 14px;">
          <table class="email-shell" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #dce9e6;border-radius:24px;overflow:hidden;box-shadow:0 16px 45px rgba(9,38,34,0.10);">
            <tr>
              <td class="email-header" style="padding:24px 34px;background:#071b18;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="width:42px;height:42px;border-radius:14px;background:#45ddce;color:#062d29;font-size:17px;font-weight:900;text-align:center;vertical-align:middle;">V</td>
                    <td style="padding-left:12px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.2px;">Vozon</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="email-body" style="padding:44px 42px 38px;">
                <div style="margin:0 0 13px;color:${tone.accent};font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;">${escapeHtml(input.eyebrow)}</div>
                <h1 style="margin:0;color:#10201e;font-size:30px;line-height:1.25;font-weight:800;letter-spacing:-0.5px;">${escapeHtml(input.title)}</h1>
                <p style="margin:20px 0 0;color:#263936;font-size:15px;line-height:1.65;font-weight:700;">${escapeHtml(greeting(input.recipientName))}</p>
                <p style="margin:8px 0 0;color:#52635f;font-size:16px;line-height:1.7;">${escapeHtml(input.intro)}</p>
                ${detailsHtml}
                ${actionHtml}
                ${supportingHtml}
                ${noticeHtml}
                ${fallbackHtml}
              </td>
            </tr>
            <tr>
              <td class="email-footer" style="padding:24px 42px;background:#f7faf9;border-top:1px solid #e4edeb;color:#81908d;font-size:12px;line-height:1.6;">
                <strong style="color:#53635f;">Vozon</strong> · AI voice conversations, made simple.<br>
                This is an automated account message from Vozon.<br>
                © ${currentYear} Vozon
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function organizationInvitationEmail(input: {
  organizationName: string;
  inviterName?: string;
  inviterEmail: string;
  recipientName?: string;
  role: InvitationRole;
  acceptUrl: string;
  expiresAt: Date;
}): TransactionalEmailContent {
  const subject = emailSubject(`Join ${input.organizationName} on Vozon`);
  const expiresAt = formatUtcDate(input.expiresAt);
  const actionUrl = safeActionUrl(input.acceptUrl);
  const role = roleLabel(input.role);
  const inviter = input.inviterName?.trim()
    ? `${input.inviterName.trim()} (${input.inviterEmail})`
    : input.inviterEmail;
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      `${inviter} invited you to join ${input.organizationName} on Vozon as ${role}.`,
      `This invitation expires on ${expiresAt}.`,
      "",
      `Accept invitation: ${actionUrl}`,
      "",
      "Sign in or create an account using the same email address that received this invitation.",
      "If you were not expecting this invitation, you can safely ignore this email.",
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: `${inviter} invited you to join ${input.organizationName} on Vozon.`,
      eyebrow: "Workspace invitation",
      title: `You’re invited to join ${input.organizationName}`,
      recipientName: input.recipientName,
      intro: `${inviter} has invited you to collaborate in their Vozon workspace.`,
      details: [
        { label: "Workspace", value: input.organizationName },
        { label: "Your role", value: role },
        { label: "Invitation expires", value: expiresAt },
      ],
      action: { label: "Accept invitation", url: actionUrl },
      supportingText: "Sign in or create an account using the same email address that received this invitation.",
      noticeText: "If you were not expecting this invitation, you can safely ignore this email.",
    }),
  };
}

export function emailVerificationEmail(input: {
  recipientEmail: string;
  recipientName?: string;
  verificationUrl: string;
}): TransactionalEmailContent {
  const subject = "Verify your Vozon email";
  const actionUrl = safeActionUrl(input.verificationUrl);
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      "Welcome to Vozon. Verify your email address to finish securing your account.",
      "",
      `Verify email: ${actionUrl}`,
      "",
      "If you did not create a Vozon account, you can safely ignore this email.",
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: "Verify your email address to finish setting up your Vozon account.",
      eyebrow: "Email verification",
      title: "Verify your email address",
      recipientName: input.recipientName,
      intro: "Welcome to Vozon. Confirm this email address to finish securing your account and keep account recovery available.",
      details: [
        { label: "Email address", value: input.recipientEmail },
        { label: "Account status", value: "Waiting for verification" },
      ],
      action: { label: "Verify email", url: actionUrl },
      supportingText: "For your security, use this link only on a device you trust.",
      noticeText: "If you did not create a Vozon account, you can safely ignore this email.",
    }),
  };
}

export function passwordResetEmail(input: {
  recipientEmail: string;
  recipientName?: string;
  resetUrl: string;
}): TransactionalEmailContent {
  const subject = "Reset your Vozon password";
  const actionUrl = safeActionUrl(input.resetUrl);
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      "We received a request to reset your Vozon password.",
      "This link expires in 1 hour.",
      "",
      `Reset password: ${actionUrl}`,
      "",
      "If you did not request this, ignore this email. Your password will remain unchanged.",
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: "Use this secure link to reset your Vozon password within one hour.",
      eyebrow: "Password reset",
      title: "Reset your password",
      recipientName: input.recipientName,
      intro: "We received a request to reset the password for your Vozon account.",
      details: [
        { label: "Account", value: input.recipientEmail },
        { label: "Link validity", value: "1 hour" },
      ],
      action: { label: "Reset password", url: actionUrl },
      supportingText: "Choose a strong password that you do not use for another account.",
      noticeText: "If you did not request this reset, ignore this email. Your password will remain unchanged.",
      tone: "brand",
    }),
  };
}

export function passwordChangedEmail(input: {
  recipientEmail: string;
  recipientName?: string;
  secureAccountUrl: string;
}): TransactionalEmailContent {
  const subject = "Your Vozon password was changed";
  const actionUrl = safeActionUrl(input.secureAccountUrl);
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      "Your Vozon password was changed successfully, and your other active sessions were revoked.",
      "",
      "If you made this change, no further action is needed.",
      `If you did not make this change, secure your account immediately: ${actionUrl}`,
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: "Your Vozon password was changed and other active sessions were revoked.",
      eyebrow: "Security update",
      title: "Your password was changed",
      recipientName: input.recipientName,
      intro: "Your Vozon password was changed successfully. Other active sessions were signed out to help protect your account.",
      details: [
        { label: "Account", value: input.recipientEmail },
        { label: "Password status", value: "Changed" },
        { label: "Other sessions", value: "Revoked" },
      ],
      action: { label: "Secure my account", url: actionUrl },
      supportingText: "If you made this change, no further action is needed.",
      noticeText: "Didn’t make this change? Reset your password immediately and contact support.",
      tone: "success",
    }),
  };
}

export function twoFactorEnabledEmail(input: {
  recipientEmail: string;
  recipientName?: string;
  securityUrl: string;
}): TransactionalEmailContent {
  const subject = "Two-factor authentication enabled";
  const actionUrl = safeActionUrl(input.securityUrl);
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      "Two-factor authentication is now enabled for your Vozon account.",
      "You will need a current authenticator code when signing in.",
      "",
      `Review security settings: ${actionUrl}`,
      "",
      "If you did not enable this protection, secure your account immediately.",
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: "Two-factor authentication is now protecting your Vozon account.",
      eyebrow: "Security strengthened",
      title: "Two-factor authentication is on",
      recipientName: input.recipientName,
      intro: "Your Vozon account now requires a current six-digit authenticator code when you sign in.",
      details: [
        { label: "Account", value: input.recipientEmail },
        { label: "Two-factor status", value: "Enabled" },
      ],
      action: { label: "Review security settings", url: actionUrl },
      supportingText: "Keep access to your authenticator secure and never share a sign-in code.",
      noticeText: "If you did not enable this protection, secure your account immediately.",
      tone: "success",
    }),
  };
}

export function twoFactorDisabledEmail(input: {
  recipientEmail: string;
  recipientName?: string;
  securityUrl: string;
}): TransactionalEmailContent {
  const subject = "Two-factor authentication disabled";
  const actionUrl = safeActionUrl(input.securityUrl);
  return {
    subject,
    text: [
      greeting(input.recipientName),
      "",
      "Two-factor authentication was disabled for your Vozon account.",
      "Your password is now the only sign-in factor.",
      "",
      `Review security settings: ${actionUrl}`,
      "",
      "If you did not make this change, secure your account immediately.",
    ].join("\n"),
    html: renderBrandedEmail({
      documentTitle: subject,
      preheader: "Two-factor authentication was disabled for your Vozon account.",
      eyebrow: "Security alert",
      title: "Two-factor authentication is off",
      recipientName: input.recipientName,
      intro: "Two-factor authentication was disabled. Your password is now the only sign-in factor protecting this account.",
      details: [
        { label: "Account", value: input.recipientEmail },
        { label: "Two-factor status", value: "Disabled" },
      ],
      action: { label: "Review security settings", url: actionUrl },
      supportingText: "For stronger protection, enable two-factor authentication again from your profile.",
      noticeText: "If you did not make this change, reset your password and secure your account immediately.",
      tone: "warning",
    }),
  };
}
