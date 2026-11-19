# Workflow automation operations

## Supported live path

The workflow API is under `/api/voice/automations`. A workspace owner or admin can publish a draft. Owners, admins, and members can start or cancel runs. Billing members can only read workflows. A run requires a published, active version, an E.164 contact number, and explicit contact consent.

Live blocks are Manual / API, campaign lead, missed inbound call, and WhatsApp inbound triggers; Call, WhatsApp, outcome router, Condition, Wait, Razorpay payment link, CRM/contact sync, Google Calendar event or Calendly link, Slack alert, and End. Each external block needs a connected service at publication. CRM can target one provider or all connected providers. Calendar can target Google, Calendly, or select automatically.

Campaign lead events are scanned every five seconds and only newly imported records are eligible. Lead imports must explicitly assert contact consent for workflow follow-up; existing suppression records and opted-out leads are skipped. A matching campaign can be selected, or all campaigns can be watched. Do not enable workflow consent for a CSV unless every included contact has agreed to the follow-up. Campaign voice calling and workflow calls are separate actions, so avoid enabling both for the same contacts unless duplicate calls are intended.

Missed inbound triggers watch one ready inbound number. They require the workspace operator to confirm that inbound callers may receive follow-up. Calls with a user transcript are excluded, as are established calls longer than ten seconds. Existing suppression records are skipped.

Call blocks require a live agent, ready outbound number assigned to that agent, an allowed calling window, and both normal and failed connections. Runtime checks suppression and available calling capacity before dialing. A failed or cancelled call follows the failed connection. WhatsApp template blocks require a connected account, Meta approval for the selected language, and a correct body variable map. Dynamic header and button parameters are not supported. Custom text and direct payment-link text require an inbound customer message within the previous 24 hours; use an approved template for outreach. Set META_APP_SECRET and a unique WHATSAPP_WEBHOOK_VERIFY_TOKEN in production so status webhooks can be verified. Meta acceptance is recorded as sent; the run waits for a signed delivered or read status. A provider failure or no delivery status within 24 hours fails the run. Status updates are deduplicated by Meta message ID and expire after seven days.

Calendar steps create a Google event only with a future appointment time. Without a time, Calendly can create a scheduling link; this is not recorded as a booking. Payment steps create a Razorpay link and expose `{{paymentLink}}` to later steps. Razorpay's own SMS, email, and reminders are disabled for this step; automatic WhatsApp payment-link text is off by default. Generated drafts never confirm contact consent or guess template variables. Operators must review those settings before publication.

Razorpay OAuth needs `read_write` authorization to create payment links, and Zoho CRM needs Leads CREATE authorization to create workflow leads. Accounts connected before these permissions were added must use **Reconnect for workflows** in Integrations. Publishing checks these saved permissions and prompts for reconnection. A connected status verifies account access, but provider permissions, live credentials, and actual delivery must still be checked in a configured test workspace before production use.

## Worker behavior

`processAutomationRuns` runs every five seconds from the backend process. Each run stores its published graph snapshot and step history. Event IDs are unique per workflow; repeated IDs return the original run. A contact cannot have two active runs in the same workflow. A workspace can have at most 100 active runs. A graph can wait for at most 90 days in total, and a run expires after 90 days.

The worker records action intent before calling a provider. If the process stops after a call or WhatsApp message ID is saved, recovery waits for its outcome instead of sending again. If a payment, calendar, CRM, notification, call, or WhatsApp action was in progress and its outcome is unknown, recovery fails the run with an operator message. It never automatically repeats a potentially accepted provider action. Cancellation stops future steps; a call already placed may continue at the provider.

WhatsApp `messageId` means Meta accepted the request, not that the contact received it. The run advances only after a signed status webhook confirms delivery or read.

## Verification

From `backend`, run `npm test`, `npm run build`, `npx tsx scripts/automationSmoke.ts`, and `npx tsx scripts/automationTriggerSmoke.ts`. The smoke scripts use isolated temporary MongoDB databases, send no provider actions, and remove their databases after completion. From `frontend`, run `npm run build`. Test a real call or WhatsApp message only in a configured test workspace with a consented destination. Review the run trace at `GET /api/voice/automations/:automationId/runs/:runId`.

Before a production rollout, run `npm run setup:dashboard-indexes` once against the intended production MongoDB database, then confirm unique indexes for `automationruns.automationId_1_eventId_1`, `automationversions.automationId_1_version_1`, and `automationwhatsappstatuses.messageId_1`; also confirm the status TTL index. Production disables automatic index creation, so a code push alone does not create these indexes. Verify that the frontend build receives `BACKEND_URL` and that the backend has its required production environment variables. For WhatsApp, configure the Meta webhook URL at `/api/webhooks/whatsapp`, subscribe the WABA to message status events, and use the same custom verification token.

For a standalone frontend deployment, start `frontend/.next/standalone/server.js` after copying `.next/static` and `public` into the standalone directory. Configure the frontend API proxy target and backend credentials for the deployment environment.
