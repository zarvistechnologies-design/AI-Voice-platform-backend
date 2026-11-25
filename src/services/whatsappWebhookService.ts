import { randomInt } from "node:crypto";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { cleanPhoneNumber, sendWhatsAppMessage } from "./whatsappService.js";
import { AutomationModel, AutomationRunModel } from "../models/Automation.js";
import { enqueueBulkAutomationRuns, parseBulkContactsText, processAutomationRuns } from "./automationRuntimeService.js";
import { matchAgentHandoffRule } from "../controllers/whatsappFeatureController.js";
import {
  createSupportCaseForContact,
  generateWhatsAppAiReply,
  initiateVoiceCallForWhatsAppContact,
  lookupSupportCasesForPhone,
} from "./whatsappProductionService.js";
import {
  bookConnectedCalendars,
  createRazorpayPaymentLinkForOrg,
  notifyConnectedSlack,
  syncLeadToConnectedCrms,
} from "./workflowIntegrationsService.js";
import {
  WhatsAppAdminDispatchBatchModel,
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppCustomAgentModel,
  WhatsAppMessageModel,
  WhatsAppFlowModel,
  WhatsAppAgentConfigModel,
  WhatsAppCampaignModel,
  WhatsAppCampaignRecipientModel,
  WhatsAppTemplateModel,
  WhatsAppFormModel,
  WhatsAppFormSubmissionModel,
} from "../models/WhatsAppEntities.js";

type RawWebhookValue = {
  messaging_product?: string;
  event?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: { name?: string };
    wa_id?: string;
  }>;
  messages?: Array<{
    from?: string;
    id?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
    button?: { text?: string; payload?: string };
    interactive?: {
      type?: string;
      button_reply?: { id?: string; title?: string };
      list_reply?: { id?: string; title?: string; description?: string };
      nfm_reply?: { name?: string; body?: string; response_json?: string };
    };
    image?: { caption?: string; id?: string; mime_type?: string };
    document?: { filename?: string; caption?: string; id?: string };
    audio?: { id?: string; mime_type?: string; voice?: boolean };
    video?: { caption?: string; id?: string };
    location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  }>;
  smb_message_echoes?: Array<{
    from?: string;
    to?: string;
    id?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }>;
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string; message?: string }>;
  }>;
};

type RawWebhookEntry = {
  id?: string;
  changes?: Array<{
    field?: string;
    value?: RawWebhookValue;
  }>;
};

/**
 * Extracts a human-readable text representation of an incoming WhatsApp message payload.
 */
function extractMessageContent(msg: NonNullable<RawWebhookValue["messages"]>[number]): string {
  const type = msg.type || "text";
  switch (type) {
    case "text":
      return msg.text?.body?.trim() || "";
    case "interactive":
      return (
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.nfm_reply?.response_json ||
        msg.interactive?.nfm_reply?.body ||
        msg.interactive?.button_reply?.id ||
        "[Interactive response]"
      );
    case "button":
      return msg.button?.text || msg.button?.payload || "[Button click]";
    case "image":
      return msg.image?.caption ? `📷 ${msg.image.caption}` : "📷 [Image attachment]";
    case "document":
      return msg.document?.filename ? `📄 ${msg.document.filename}` : "📄 [Document attachment]";
    case "audio":
      return msg.audio?.voice ? "🎙️ [Voice Note]" : "🎵 [Audio file]";
    case "video":
      return msg.video?.caption ? `🎥 ${msg.video.caption}` : "🎥 [Video attachment]";
    case "location":
      return msg.location?.name
        ? `📍 ${msg.location.name} (${msg.location.address || ""})`
        : "📍 [Location pin shared]";
    default:
      return `[${type} attachment]`;
  }
}

/**
 * Ingests incoming WhatsApp Cloud API webhook entries.
 * Handles:
 * 1. Inbound messages -> Creates/updates contacts, conversations, and messages.
 * 2. Coexistence SMB message echoes -> Mirrors messages sent by business owners from mobile app.
 * 3. Message statuses -> Updates delivered/read/failed states and campaign metrics.
 * 4. Automated AI Bot / Flow triggers & human handover keyword detection.
 */
export async function processWhatsAppInboundWebhook(body: Record<string, unknown>): Promise<void> {
  if (body?.object !== "whatsapp_business_account") return;

  const entries = (Array.isArray(body.entry) ? body.entry : []) as RawWebhookEntry[];

  for (const entry of entries) {
    const wabaId = String(entry.id ?? "").trim();
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const val = change.value;
      if (!val) continue;

      if (change.field === "message_template_status_update") {
        const integration = await ProviderIntegrationModel.findOne({
          provider: "whatsapp",
          status: "connected",
          "metadata.wabaId": wabaId,
        });
        if (!integration) continue;
        const event = String(val.event || "").toUpperCase();
        const status: "APPROVED" | "PENDING" | "REJECTED" = event === "APPROVED" || event === "REJECTED" ? event : "PENDING";
        const templateId = String(val.message_template_id ?? "");
        const templateName = String(val.message_template_name ?? "");
        const selector = [
          ...(templateId ? [{ metaTemplateId: templateId }] : []),
          ...(templateName ? [{ name: templateName }] : []),
        ];
        if (selector.length > 0) {
          await WhatsAppTemplateModel.updateOne(
            { ownerId: integration.ownerId, $or: selector },
            { $set: { status } },
          );
        }
        continue;
      }

      const phoneNumberId = String(val.metadata?.phone_number_id ?? "").trim();
      const displayPhoneNumber = String(val.metadata?.display_phone_number ?? "").trim();

      // Find the associated organization integration
      const integration = await ProviderIntegrationModel.findOne({
        provider: "whatsapp",
        status: "connected",
        $or: [
          ...(phoneNumberId ? [{ accountId: phoneNumberId }, { "metadata.phoneNumberId": phoneNumberId }] : []),
          ...(wabaId ? [{ "metadata.wabaId": wabaId }] : []),
        ],
      }).select("+secretEncrypted");

      if (!integration) {
        console.warn("WhatsApp webhook could not map an event to a connected account:", {
          wabaId,
          phoneNumberId,
        });
        continue;
      }

      const ownerId = integration.ownerId;
      let accessToken = "";
      try {
        if (integration.secretEncrypted) {
          accessToken = decryptSecret(integration.secretEncrypted);
        }
      } catch {
        /* Continue without token if decryption fails */
      }

      // ----------------------------------------------------
      // 1. Process Message Status Updates (sent, delivered, read, failed)
      // ----------------------------------------------------
      if (Array.isArray(val.statuses) && val.statuses.length > 0) {
        for (const st of val.statuses) {
          const messageId = String(st.id ?? "").trim();
          const status = String(st.status ?? "").toLowerCase();
          if (!messageId || !["sent", "delivered", "read", "failed"].includes(status)) continue;

          const existingMsg = await WhatsAppMessageModel.findOneAndUpdate(
            { metaMessageId: messageId },
            { $set: { status: status as "sent" | "delivered" | "read" | "failed" } },
            { new: false },
          );

          // Update exact campaign metrics when the message status transitions
          if (existingMsg?.campaignId && existingMsg.status !== status) {
            await WhatsAppCampaignRecipientModel.updateOne(
              { metaMessageId: messageId },
              { $set: { status } },
            );
            if (status === "delivered") {
              await WhatsAppCampaignModel.updateOne(
                { _id: existingMsg.campaignId },
                { $inc: { "stats.delivered": 1 } },
              );
            } else if (status === "read") {
              await WhatsAppCampaignModel.updateOne(
                { _id: existingMsg.campaignId },
                { $inc: { "stats.read": 1 } },
              );
            } else if (status === "failed") {
              await WhatsAppCampaignModel.updateOne(
                { _id: existingMsg.campaignId },
                { $inc: { "stats.failed": 1 } },
              );
            }
          }
        }
      }

      // ----------------------------------------------------
      // 2. Process WhatsApp Coexistence Mobile App Echoes
      // (Sent by business owner directly from mobile WhatsApp Business app)
      // ----------------------------------------------------
      if (Array.isArray(val.smb_message_echoes) && val.smb_message_echoes.length > 0) {
        for (const echo of val.smb_message_echoes) {
          const recipientPhone = cleanPhoneNumber(String(echo.to ?? ""));
          const echoContent = echo.text?.body?.trim() || "[Mobile message sent]";
          const echoMetaId = String(echo.id ?? "").trim();

          if (!recipientPhone) continue;

          // Avoid duplicate insertion
          if (echoMetaId) {
            const exists = await WhatsAppMessageModel.exists({ metaMessageId: echoMetaId });
            if (exists) continue;
          }

          // Locate or create conversation
          let conversation = await WhatsAppConversationModel.findOne({
            ownerId,
            contactPhone: recipientPhone,
          });

          if (!conversation) {
            conversation = await WhatsAppConversationModel.create({
              ownerId,
              contactPhone: recipientPhone,
              contactName: "Customer",
              lastMessageText: echoContent,
              lastMessageTimestamp: new Date(),
              unreadCount: 0,
              status: "open",
              mode: "human", // Switched to human because staff answered from mobile app
              tags: ["Coexistence-Mobile"],
            });
          } else {
            conversation.lastMessageText = echoContent;
            conversation.lastMessageTimestamp = new Date();
            // Automatically set conversation mode to human when business owner replies manually
            conversation.mode = "human";
            await conversation.save();
          }

          await WhatsAppMessageModel.create({
            ownerId,
            conversationId: conversation._id,
            direction: "outbound",
            senderPhone: displayPhoneNumber || "WhatsApp Business Mobile App",
            recipientPhone,
            type: echo.type || "text",
            content: echoContent,
            status: "delivered",
            metaMessageId: echoMetaId,
          });
        }
      }

      // ----------------------------------------------------
      // 3. Process Inbound Messages from Customers
      // ----------------------------------------------------
      if (Array.isArray(val.messages) && val.messages.length > 0) {
        const contactsList = Array.isArray(val.contacts) ? val.contacts : [];

        for (const msg of val.messages) {
          const from = cleanPhoneNumber(String(msg.from ?? ""));
          const metaMsgId = String(msg.id ?? "").trim();
          if (!from) continue;

          // Deduplication
          if (metaMsgId) {
            const exists = await WhatsAppMessageModel.exists({ metaMessageId: metaMsgId });
            if (exists) continue;
          }

          const content = extractMessageContent(msg);
          if (!content) continue;
          const optedOut = /^(stop|unsubscribe|cancel|end|quit)$/i.test(content.trim());
          const optedIn = /^start$/i.test(content.trim());

          // Resolve contact profile name if provided by Meta
          const profileContact = contactsList.find((c) => c.wa_id === msg.from);
          const profileName = profileContact?.profile?.name?.trim() || "";

          // Upsert contact in WhatsApp contacts list
          await WhatsAppContactModel.findOneAndUpdate(
            { ownerId, phoneNumber: from },
            {
              $set: {
                lastContactedAt: new Date(),
                ...(profileName ? { name: profileName } : {}),
                ...(optedIn ? { marketingOptInAt: new Date(), marketingOptInSource: "whatsapp_start" } : {}),
              },
              $setOnInsert: {
                ownerId,
                phoneNumber: from,
                ...(!profileName ? { name: "WhatsApp Customer" } : {}),
                status: optedOut ? "opted_out" : optedIn ? "subscribed" : "pending_consent",
                tags: ["Inbound"],
              },
            },
            { upsert: true, new: true },
          );
          if (optedOut || optedIn) {
            await WhatsAppContactModel.updateOne(
              { ownerId, phoneNumber: from },
              { $set: optedOut ? { status: "opted_out" } : { status: "subscribed", marketingOptInAt: new Date(), marketingOptInSource: "whatsapp_start" } },
            );
          }

          // Find or create active conversation
          let conversation = await WhatsAppConversationModel.findOne({
            ownerId,
            contactPhone: from,
          });

          const isNewConversation = !conversation;

          if (!conversation) {
            conversation = await WhatsAppConversationModel.create({
              ownerId,
              contactPhone: from,
              contactName: profileName || "Customer",
              recipientPhoneNumberId: phoneNumberId,
              recipientDisplayPhone: displayPhoneNumber,
              lastMessageText: content,
              lastMessageTimestamp: new Date(),
              unreadCount: 1,
              status: "open",
              mode: "ai",
              tags: ["Inbound"],
            });
          } else {
            conversation.lastMessageText = content;
            conversation.lastMessageTimestamp = new Date();
            conversation.unreadCount = (conversation.unreadCount || 0) + 1;
            conversation.status = "open";
            if (phoneNumberId) conversation.recipientPhoneNumberId = phoneNumberId;
            if (displayPhoneNumber) conversation.recipientDisplayPhone = displayPhoneNumber;
            if (profileName && (!conversation.contactName || conversation.contactName === "Customer")) {
              conversation.contactName = profileName;
            }
            await conversation.save();
          }

          // Persist inbound message in conversation
          await WhatsAppMessageModel.create({
            ownerId,
            conversationId: conversation._id,
            direction: "inbound",
            senderPhone: from,
            recipientPhone: phoneNumberId || displayPhoneNumber || "Platform",
            type: msg.type || "text",
            content,
            status: "delivered",
            metaMessageId: metaMsgId,
          });

          const recentConversationMessages = await WhatsAppMessageModel.find({
            ownerId,
            conversationId: conversation._id,
            direction: { $in: ["inbound", "outbound"] },
          })
            .sort({ createdAt: -1 })
            .limit(12)
            .select("direction content")
            .lean();
          const whatsappConversation = recentConversationMessages
            .reverse()
            .map((message) => {
              const speaker = message.direction === "inbound" ? "Customer" : "Assistant";
              const text = String(message.content || "").replace(/\s+/g, " ").trim();
              return text ? `${speaker}: ${text}` : "";
            })
            .filter(Boolean)
            .join("\n")
            .slice(-6000);

          if (optedOut || optedIn) {
            if (accessToken && phoneNumberId) {
              try {
                const confirmation = optedOut
                  ? "You have been unsubscribed from WhatsApp broadcasts. Reply START if you want to opt in again."
                  : "You are now opted in to WhatsApp broadcasts. Reply STOP at any time to unsubscribe.";
                const sent = await sendWhatsAppMessage(phoneNumberId, accessToken, from, { type: "text", text: confirmation });
                await WhatsAppMessageModel.create({
                  ownerId,
                  conversationId: conversation._id,
                  direction: "outbound",
                  senderPhone: displayPhoneNumber || "Support",
                  recipientPhone: from,
                  type: "text",
                  content: confirmation,
                  status: "sent",
                  metaMessageId: sent.messageId,
                });
              } catch (error) {
                console.warn("Could not send WhatsApp opt-out confirmation:", error instanceof Error ? error.message : error);
              }
            }
            continue;
          }

          // Increment replied count on the exact campaign this customer is replying to
          const recentCampaignMsg = await WhatsAppMessageModel.findOne({
            conversationId: conversation._id,
            direction: "outbound",
            campaignId: { $ne: null },
            createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
          }).sort({ createdAt: -1 });
          if (recentCampaignMsg?.campaignId) {
            await WhatsAppCampaignModel.updateOne(
              { _id: recentCampaignMsg.campaignId },
              { $inc: { "stats.replied": 1 } },
            );
          }

          // ----------------------------------------------------
          // 3a. Authorized Admin-Only Bulk Dispatch via WhatsApp
          // ----------------------------------------------------
          try {
            const adminConfig = await WhatsAppAgentConfigModel.findOne({ ownerId }).lean();
            const allowlistedAdmins = Array.isArray(adminConfig?.adminDispatchPhones)
              ? adminConfig.adminDispatchPhones.map((p) => cleanPhoneNumber(String(p || ""))).filter(Boolean)
              : [];
            const senderDigits = cleanPhoneNumber(from);
            const isAuthorizedAdmin = Boolean(senderDigits && allowlistedAdmins.includes(senderDigits));

            if (isAuthorizedAdmin && accessToken && phoneNumberId) {
              const trimmedCmd = content.trim();
              const upperCmd = trimmedCmd.toUpperCase();

              const replyToAdmin = async (replyText: string) => {
                const sent = await sendWhatsAppMessage(phoneNumberId, accessToken, from, {
                  type: "text",
                  text: replyText,
                }).catch(() => ({ messageId: "" }));
                await WhatsAppMessageModel.create({
                  ownerId,
                  conversationId: conversation._id,
                  direction: "outbound",
                  senderPhone: "Vozon Admin Dispatch",
                  recipientPhone: from,
                  type: "text",
                  content: replyText,
                  status: sent.messageId ? "delivered" : "failed",
                  metaMessageId: sent.messageId || `admin_${Date.now()}`,
                });
                conversation.lastMessageText = replyText;
                conversation.lastMessageTimestamp = new Date();
                await conversation.save();
              };

              // Emergency Kill Switch: STOP BATCH / STOP CALLS
              if (/^STOP(?:\s+(?:BATCH|CALLS|ALL))?$/i.test(upperCmd)) {
                const cancelled = await AutomationRunModel.updateMany(
                  {
                    ownerId,
                    status: { $in: ["queued", "waiting"] },
                    "context.source": "whatsapp_admin_dispatch",
                  },
                  {
                    $set: {
                      status: "cancelled",
                      dueAt: null,
                      leaseUntil: null,
                      finishedAt: new Date(),
                      error: `Stopped by authorized admin (${from}) via WhatsApp.`,
                    },
                  },
                );
                await WhatsAppAdminDispatchBatchModel.updateMany(
                  { ownerId, adminPhone: senderDigits, status: "pending" },
                  { $set: { status: "cancelled" } },
                );
                await replyToAdmin(
                  `🛑 Stopped ${cancelled.modifiedCount} queued/waiting admin bulk run${cancelled.modifiedCount === 1 ? "" : "s"}. Active calls already connected will finish normally.`,
                );
                continue;
              }

              // Cancel pending confirmation
              if (upperCmd === "CANCEL") {
                const cancelledBatch = await WhatsAppAdminDispatchBatchModel.updateMany(
                  { ownerId, adminPhone: senderDigits, status: "pending" },
                  { $set: { status: "cancelled" } },
                );
                if (cancelledBatch.modifiedCount > 0) {
                  await replyToAdmin("Cancelled your pending bulk dispatch batch.");
                  continue;
                }
              }

              // Confirm pending batch: CONFIRM 1234
              const confirmMatch = upperCmd.match(/^CONFIRM\s+(\d{4})$/);
              if (confirmMatch) {
                const code = confirmMatch[1];
                const pendingBatch = await WhatsAppAdminDispatchBatchModel.findOne({
                  ownerId,
                  adminPhone: senderDigits,
                  code,
                  status: "pending",
                  expiresAt: { $gt: new Date() },
                }).sort({ createdAt: -1 });

                if (!pendingBatch) {
                  await replyToAdmin("No active pending batch matched that code (or it expired after 10 minutes). Send the numbers again to create a new batch.");
                  continue;
                }

                const maxBatch = Math.min(500, Math.max(1, Number(adminConfig?.adminDispatchMaxBatch || 200)));
                const summary = await enqueueBulkAutomationRuns({
                  ownerId,
                  automationId: pendingBatch.automationId,
                  contacts: pendingBatch.contacts.map((c) => ({ name: c.name || "", phone: c.phone })),
                  source: "whatsapp_admin_dispatch",
                  requestedBy: `whatsapp_admin:${senderDigits}`,
                  maxBatch,
                });
                pendingBatch.status = "confirmed";
                await pendingBatch.save();

                await replyToAdmin(
                  `✅ *Admin Bulk Dispatch Started*\nWorkflow: *${summary.automationName}*\nQueued: *${summary.queued}* contact${summary.queued === 1 ? "" : "s"}${summary.skippedDuplicates ? `\nDuplicates skipped: ${summary.skippedDuplicates}` : ""}${summary.skippedDnc ? `\nDNC skipped: ${summary.skippedDnc}` : ""}${summary.capped ? `\nCapped (over limit): ${summary.capped}` : ""}\n\nReply *STOP BATCH* anytime to halt remaining queued runs.`,
                );
                continue;
              }

              // Detect bulk number list (2+ phone numbers OR explicit command prefix with 1+ numbers)
              const hasCommandPrefix = /^(?:CALL|BULK|DISPATCH|FOLLOWUP|FOLLOW-UP)\b/i.test(trimmedCmd);
              const extractedContacts = parseBulkContactsText(trimmedCmd);
              if (extractedContacts.length >= 2 || (hasCommandPrefix && extractedContacts.length >= 1)) {
                const targetFlow = (adminConfig?.adminDispatchAutomationId
                  ? await AutomationModel.findOne({
                    _id: adminConfig.adminDispatchAutomationId,
                    ownerId,
                    status: "live",
                    published: { $ne: null },
                  }).catch(() => null)
                  : null) ||
                  (await AutomationModel.findOne({
                    ownerId,
                    status: "live",
                    published: { $ne: null },
                  }).sort({ updatedAt: -1 }));

                if (!targetFlow) {
                  await replyToAdmin("⚠️ No published live Automation Workflow found. Publish a workflow first (and optionally select it under WhatsApp → Agents → Admin Bulk Dispatch).");
                  continue;
                }

                const maxBatch = Math.min(500, Math.max(1, Number(adminConfig?.adminDispatchMaxBatch || 200)));
                const phoneVariantsAll = extractedContacts.flatMap((c) => [c.phone, cleanPhoneNumber(c.phone)]);
                const suppressedDocs = await ContactSuppressionModel.find({
                  ownerId,
                  phone: { $in: phoneVariantsAll },
                }).select("phone").lean();
                const suppressedSet = new Set(suppressedDocs.map((d) => cleanPhoneNumber(String(d.phone || ""))));

                const eligibleContacts = extractedContacts.filter((c) => !suppressedSet.has(cleanPhoneNumber(c.phone))).slice(0, maxBatch);
                const skippedDnc = extractedContacts.filter((c) => suppressedSet.has(cleanPhoneNumber(c.phone))).length;

                if (eligibleContacts.length === 0) {
                  await replyToAdmin(`All ${extractedContacts.length} numbers are on the Do-Not-Call list. Nothing to dispatch.`);
                  continue;
                }

                await WhatsAppAdminDispatchBatchModel.updateMany(
                  { ownerId, adminPhone: senderDigits, status: "pending" },
                  { $set: { status: "cancelled" } },
                );

                const confirmCode = String(randomInt(1000, 10000));
                await WhatsAppAdminDispatchBatchModel.create({
                  ownerId,
                  adminPhone: senderDigits,
                  automationId: String(targetFlow._id),
                  automationName: targetFlow.name,
                  code: confirmCode,
                  contacts: eligibleContacts,
                  skippedDuplicates: 0,
                  skippedDnc,
                  status: "pending",
                  expiresAt: new Date(Date.now() + 10 * 60_000),
                });

                await replyToAdmin(
                  `🔒 *Admin Bulk Dispatch Ready*\nWorkflow: *${targetFlow.name}*\nContacts ready: *${eligibleContacts.length}*${skippedDnc ? ` (DNC skipped: ${skippedDnc})` : ""}${extractedContacts.length > maxBatch ? ` (capped at ${maxBatch})` : ""}\n\nReply *CONFIRM ${confirmCode}* within 10 minutes to start calling & follow-ups, or reply *CANCEL*.`,
                );
                continue;
              }
            }
          } catch (adminErr) {
            console.warn("[WhatsApp Webhook] Admin bulk dispatch error:", adminErr);
          }

          // ----------------------------------------------------
          // 3b. Wake up & trigger live Unified Automation Workflows
          // ----------------------------------------------------
          try {
            const phoneVariants = from.startsWith("+") ? [from, from.slice(1)] : [from, `+${from}`];
            const isMetaFormSubmit = Boolean(msg.type === "interactive" && (msg.interactive?.type === "nfm_reply" || msg.interactive?.nfm_reply));

            // Immediately wake up ANY workflow run waiting for a WhatsApp reply from this contact
            const woken = await AutomationRunModel.updateMany(
              {
                ownerId,
                contactPhone: { $in: phoneVariants },
                status: "waiting",
                waitKind: "whatsapp_reply",
              },
              {
                $set: {
                  dueAt: new Date(),
                  "context.waitReplyMatched": true,
                  "context.whatsappReply": content,
                  "context.lastMessageText": content,
                  "context.whatsappConversation": whatsappConversation,
                  ...(isMetaFormSubmit ? { "context.formResponse": content } : {}),
                },
              },
            );
            if (woken.modifiedCount > 0) {
              void processAutomationRuns().catch(() => undefined);
            }

            // Keep reply context fresh on any other active runs (e.g. voice/campaign/webhook flows)
            await AutomationRunModel.updateMany(
              {
                ownerId,
                contactPhone: { $in: phoneVariants },
                status: { $in: ["queued", "waiting"] },
                waitKind: { $ne: "whatsapp_reply" },
              },
              {
                $set: {
                  "context.whatsappReply": content,
                  "context.lastMessageText": content,
                  "context.whatsappConversation": whatsappConversation,
                  ...(isMetaFormSubmit ? { "context.formResponse": content } : {}),
                },
              },
            );

            const matchingEvents = isMetaFormSubmit
              ? ["whatsapp_form_submitted", "whatsapp_inbound"]
              : ["whatsapp_inbound"];
            const liveAutomations = await AutomationModel.find({
              ownerId,
              status: "live",
              published: { $ne: null },
            });
            for (const flowDoc of liveAutomations) {
              const graph = flowDoc.published as { nodes?: Array<{ id: string; type: string; config: Record<string, string> }> };
              const trigger = graph?.nodes?.find((n) => n.type === "trigger");
              if (trigger && matchingEvents.includes(trigger.config.event)) {
                const rawKeywords = (trigger.config.keyword || "")
                  .split(",")
                  .map((k) => k.trim().toLowerCase())
                  .filter(Boolean);
                const matchTarget = `${content} ${msg.interactive?.nfm_reply?.name || ""}`.toLowerCase();
                if (rawKeywords.length === 0 || rawKeywords.some((kw) => matchTarget.includes(kw))) {
                  const existingActive = await AutomationRunModel.exists({
                    ownerId,
                    automationId: flowDoc._id,
                    contactPhone: { $in: phoneVariants },
                    status: { $in: ["queued", "running", "waiting"] },
                  });
                  if (!existingActive) {
                    const eventId = `${trigger.config.event}:${from}:${metaMsgId || Date.now()}`;
                    const e164ContactPhone = from.startsWith("+") ? from : `+${from}`;
                    await AutomationRunModel.create({
                      ownerId,
                      automationId: flowDoc._id,
                      version: flowDoc.publishedVersion,
                      graph,
                      eventId,
                      contactName: profileName || "WhatsApp Customer",
                      contactPhone: e164ContactPhone,
                      status: "queued",
                      currentNodeId: trigger.id,
                      context: {
                        consentConfirmed: true,
                        source: trigger.config.event,
                        whatsappReply: content,
                        lastMessageText: content,
                        whatsappConversation,
                        recipientPhoneNumberId: phoneNumberId,
                        ...(isMetaFormSubmit ? { formResponse: content, formName: msg.interactive?.nfm_reply?.name || "" } : {}),
                      },
                    });
                    void processAutomationRuns().catch(() => undefined);
                  }
                }
              }
            }
          } catch (autoErr) {
            console.warn("[WhatsApp Webhook] Automation trigger error:", autoErr);
          }

          // ----------------------------------------------------
          // 4. Automated AI Auto-Reply & Keyword Flow Routing
          // ----------------------------------------------------
          if (conversation.mode === "ai" && accessToken && phoneNumberId) {
            try {
              const [agentConfig, liveCustomAgents] = await Promise.all([
                WhatsAppAgentConfigModel.findOne({ ownerId }),
                WhatsAppCustomAgentModel.find({ ownerId, status: "live" }).sort({ isDefault: -1, updatedAt: -1 }),
              ]);

              const lowerContent = content.toLowerCase();

              // Resolve the best Live Custom WhatsApp AI Agent:
              // 1) Explicit triggerKeywords match on incoming message
              // 2) Sticky assignedAgentId already on conversation
              // 3) Agent specifically bound to this incoming WhatsApp phoneNumberId
              // 4) Workspace default agent -> latest live agent
              const matchedByKeyword = liveCustomAgents.find((a) =>
                (a.triggerKeywords || []).some((kw) => {
                  const cleanKw = String(kw || "").trim().toLowerCase();
                  return cleanKw.length > 0 && lowerContent.includes(cleanKw);
                }),
              );
              const stickyAgent = conversation.assignedAgentId
                ? liveCustomAgents.find((a) => String(a._id) === conversation.assignedAgentId)
                : undefined;
              const matchedByLine = liveCustomAgents.find(
                (a) => a.phoneNumberId && a.phoneNumberId === phoneNumberId,
              );
              const defaultAgent = liveCustomAgents.find((a) => a.isDefault) || liveCustomAgents[0];
              let activeCustomAgent = stickyAgent || matchedByKeyword || matchedByLine || defaultAgent;
              let handoffAnnounceMessage = "";

              // Check explicit Agent-to-Agent Handoff Rules on the current agent (supports up to 1 hop per turn)
              if (activeCustomAgent && Array.isArray(activeCustomAgent.handoffRules) && activeCustomAgent.handoffRules.length > 0) {
                const matchedRule = matchAgentHandoffRule(activeCustomAgent.handoffRules, content);
                if (matchedRule) {
                  const targetAgent = liveCustomAgents.find(
                    (a) => String(a._id) === String(matchedRule.targetAgentId),
                  );
                  if (targetAgent && String(targetAgent._id) !== String(activeCustomAgent._id)) {
                    activeCustomAgent = targetAgent;
                    handoffAnnounceMessage = String(matchedRule.announceMessage || "").trim();
                  }
                }
              }

              // If no explicit handoff fired on sticky agent, still allow global keyword routing to switch specialists
              if (!handoffAnnounceMessage && matchedByKeyword && activeCustomAgent && String(matchedByKeyword._id) !== String(activeCustomAgent._id)) {
                activeCustomAgent = matchedByKeyword;
              }

              if (activeCustomAgent && conversation.assignedAgentId !== String(activeCustomAgent._id)) {
                conversation.assignedAgentId = String(activeCustomAgent._id);
                await conversation.save();
              }

              const masterEnabled = agentConfig ? agentConfig.enabled !== false : true;
              const effectiveAutoReply = activeCustomAgent
                ? activeCustomAgent.autoReply !== false
                : Boolean(agentConfig?.autoReply);

              if (masterEnabled && effectiveAutoReply && (activeCustomAgent || agentConfig)) {
                // 4a. Check for Human Handover Transfer Keywords
                const rawTransferKeywords =
                  activeCustomAgent?.transferKeywords?.length
                    ? activeCustomAgent.transferKeywords
                    : agentConfig?.transferKeywords || [];
                const transferKeywords = rawTransferKeywords.map((k) =>
                  String(k).trim().toLowerCase(),
                );
                const isTransfer = transferKeywords.some(
                  (kw) => kw.length > 0 && lowerContent.includes(kw),
                );

                if (isTransfer) {
                  conversation.mode = "human";
                  await conversation.save();

                  const handoverMsg =
                    activeCustomAgent?.fallbackMessage ||
                    agentConfig?.fallbackMessage ||
                    "I am passing your conversation to a live care specialist. They will be with you shortly.";

                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    {
                      type: "text",
                      text: handoverMsg,
                    },
                  );

                  await WhatsAppMessageModel.create({
                    ownerId,
                    conversationId: conversation._id,
                    direction: "outbound",
                    senderPhone: activeCustomAgent?.name || "Vozon AI Assistant",
                    recipientPhone: from,
                    type: "text",
                    content: handoverMsg,
                    status: "delivered",
                    metaMessageId: sendResult.messageId,
                  });

                  conversation.lastMessageText = handoverMsg;
                  conversation.lastMessageTimestamp = new Date();
                  await conversation.save();
                  continue;
                }

                // 4a-bis. Support Case Lookup ("CASE-1001" or "my case status")
                const caseIdMatch = content.match(/\b(CASE-\d{3,8})\b/i);
                const asksCaseStatus =
                  Boolean(caseIdMatch) ||
                  /\b(case status|ticket status|my case|my ticket|check case)\b/i.test(lowerContent);
                if (asksCaseStatus && !conversation.activeFlowId) {
                  const foundCases = await lookupSupportCasesForPhone(ownerId, from, caseIdMatch?.[1]);
                  if (foundCases.length > 0) {
                    const statusReply = foundCases
                      .map((c) => `🎫 *${c.caseNumber}* (${c.status.replace("_", " ").toUpperCase()})\nSubject: ${c.subject}\nCategory: ${c.category} • Priority: ${c.priority}`)
                      .join("\n\n");
                    const sendResult = await sendWhatsAppMessage(phoneNumberId, accessToken, from, {
                      type: "text",
                      text: statusReply,
                    });
                    await WhatsAppMessageModel.create({
                      ownerId,
                      conversationId: conversation._id,
                      direction: "outbound",
                      senderPhone: "Vozon Support Desk",
                      recipientPhone: from,
                      type: "text",
                      content: statusReply,
                      status: "delivered",
                      metaMessageId: sendResult.messageId,
                    });
                    conversation.lastMessageText = statusReply;
                    conversation.lastMessageTimestamp = new Date();
                    await conversation.save();
                    continue;
                  }
                }

                // 4b. Check for Resumed or Newly Triggered Visual Flow Maker Workflow
                const activeFlows = await WhatsAppFlowModel.find({
                  ownerId,
                  status: "active",
                  $or: [{ phoneNumberId: "" }, { phoneNumberId: phoneNumberId }, { phoneNumberId: { $exists: false } }],
                });
                const resumedFlow = conversation.activeFlowId
                  ? activeFlows.find((f) => String(f._id) === conversation.activeFlowId)
                  : undefined;
                const matchedFlow =
                  resumedFlow ||
                  activeFlows.find(
                    (flow) =>
                      (!flow.phoneNumberId || flow.phoneNumberId === phoneNumberId) &&
                      flow.triggerKeyword &&
                      lowerContent.includes(flow.triggerKeyword.toLowerCase()),
                  );

                if (matchedFlow) {
                  if (!resumedFlow) {
                    matchedFlow.executionCount = (matchedFlow.executionCount || 0) + 1;
                    await matchedFlow.save();
                  }

                  const nodes = (Array.isArray(matchedFlow.nodes) ? matchedFlow.nodes : []) as Array<{
                    id?: string;
                    type?: string;
                    title?: string;
                    description?: string;
                  }>;
                  const edges = (Array.isArray(matchedFlow.edges) ? matchedFlow.edges : []) as Array<{
                    from?: string;
                    to?: string;
                    caseLabel?: string;
                    matchKeywords?: string;
                  }>;

                  const nextNodeAfter = (currentId?: string, replyText?: string) => {
                    if (!currentId) return undefined;
                    const outgoing = edges.filter((e) => e.from === currentId);
                    if (outgoing.length > 0) {
                      if (replyText && outgoing.length > 1) {
                        const normalizedReply = replyText.trim().toLowerCase();
                        const matchedEdge = outgoing.find((e) => {
                          const kwList = String(e.matchKeywords || e.caseLabel || "")
                            .split(",")
                            .map((k) => k.trim().toLowerCase())
                            .filter((k) => k && k !== "default" && k !== "else");
                          return kwList.some((kw) => normalizedReply === kw || normalizedReply.includes(kw));
                        });
                        if (matchedEdge?.to) return nodes.find((n) => n.id === matchedEdge.to);

                        const fallbackEdge = outgoing.find((e) => {
                          const kw = String(e.matchKeywords || e.caseLabel || "").trim().toLowerCase();
                          return kw === "default" || kw === "else" || kw === "*";
                        });
                        if (fallbackEdge?.to) return nodes.find((n) => n.id === fallbackEdge.to);
                      }
                      const firstTarget = outgoing[0]?.to;
                      if (firstTarget) return nodes.find((n) => n.id === firstTarget);
                    }
                    const idx = nodes.findIndex((n) => n.id === currentId);
                    return idx >= 0 && idx + 1 < nodes.length ? nodes[idx + 1] : undefined;
                  };

                  let currentNode = resumedFlow && conversation.activeFlowNodeId
                    ? nodes.find((n) => n.id === conversation.activeFlowNodeId)
                    : nodes.find((n) => n.type === "trigger") || nodes[0];

                  const flowCtx: Record<string, string> = {
                    ...((conversation.activeFlowContext as Record<string, string> | undefined) || {}),
                  };

                  // If resuming on a waiting form or condition node, capture user response & advance
                  if (resumedFlow && currentNode && (currentNode.type === "form" || currentNode.type === "condition")) {
                    if (currentNode.type === "form") {
                      flowCtx[`form_${currentNode.id || "step"}`] = content;
                      const matchingForm = await WhatsAppFormModel.findOne({ ownerId, status: "active" });
                      if (matchingForm) {
                        await WhatsAppFormSubmissionModel.create({
                          ownerId,
                          formId: matchingForm._id,
                          contactPhone: from,
                          contactName: profileName || conversation.contactName || "Customer",
                          data: { response: content, stepTitle: currentNode.title || "Flow Form" },
                        });
                        await WhatsAppFormModel.updateOne({ _id: matchingForm._id }, { $inc: { submissionCount: 1 } });
                        // Also trigger any live Automation Workflows listening to whatsapp_form_submitted
                        try {
                          const formFlows = await AutomationModel.find({
                            ownerId,
                            status: "live",
                            published: { $ne: null },
                          });
                          const formMatchText = `${matchingForm.title || ""} ${String(matchingForm._id)} ${currentNode.title || ""} ${content}`.toLowerCase();
                          for (const flowDoc of formFlows) {
                            const fGraph = flowDoc.published as { nodes?: Array<{ id: string; type: string; config: Record<string, string> }> };
                            const fTrigger = fGraph?.nodes?.find((n) => n.type === "trigger");
                            if (!fTrigger || fTrigger.config.event !== "whatsapp_form_submitted") continue;
                            const kw = (fTrigger.config.keyword || "").trim().toLowerCase();
                            if (kw && !formMatchText.includes(kw)) continue;
                            const hasActive = await AutomationRunModel.exists({
                              ownerId,
                              automationId: flowDoc._id,
                              contactPhone: from,
                              status: { $in: ["queued", "running", "waiting"] },
                            });
                            if (!hasActive) {
                              await AutomationRunModel.create({
                                ownerId,
                                automationId: flowDoc._id,
                                version: flowDoc.publishedVersion,
                                graph: fGraph,
                                eventId: `wa_form:${from}:${metaMsgId || Date.now()}`,
                                contactName: profileName || conversation.contactName || "WhatsApp Customer",
                                contactPhone: from,
                                status: "queued",
                                currentNodeId: fTrigger.id,
                                context: {
                                  consentConfirmed: true,
                                  source: "whatsapp_form_submitted",
                                  whatsappReply: content,
                                  lastMessageText: content,
                                  formId: String(matchingForm._id),
                                  formName: matchingForm.title || "",
                                  formResponse: content,
                                  recipientPhoneNumberId: phoneNumberId,
                                },
                              });
                              void processAutomationRuns().catch(() => undefined);
                            }
                          }
                        } catch (formAutoErr) {
                          console.warn("[WhatsApp Webhook] Form automation trigger error:", formAutoErr);
                        }
                      }
                      currentNode = nextNodeAfter(currentNode.id);
                    } else {
                      flowCtx[`choice_${currentNode.id || "step"}`] = content;
                      currentNode = nextNodeAfter(currentNode.id, content);
                    }
                  } else if (!resumedFlow && currentNode?.type === "trigger") {
                    currentNode = nextNodeAfter(currentNode.id);
                  }

                  const replySegments: string[] = [];
                  let awaitingNextReplyNodeId = "";
                  let switchToHuman = false;
                  const buttonOptions: Array<{ id: string; title: string }> = [];

                  for (let hop = 0; hop < 10 && currentNode; hop += 1) {
                    const nodeText = `${currentNode.title || ""} ${currentNode.description || ""}`;
                    const lowerNodeText = nodeText.toLowerCase();

                    if (currentNode.type === "message") {
                      let msgText = String(currentNode.description || currentNode.title || "").trim();
                      msgText = msgText
                        .replace(/\{\{\s*name\s*\}\}/gi, profileName || conversation.contactName || "there")
                        .replace(/\{\{\s*phone\s*\}\}/gi, from)
                        .replace(/\{\{\s*paymentLink\s*\}\}/gi, flowCtx.paymentLink || "")
                        .replace(/\{\{\s*calendlyLink\s*\}\}/gi, flowCtx.calendlyLink || "")
                        .replace(/\{\{\s*caseNumber\s*\}\}/gi, flowCtx.caseNumber || "");

                      // Extract quick-reply button options if numbered lines exist (up to 3 Meta buttons)
                      const optionMatches = msgText.match(/^(?:[1-3]️⃣|[1-3][\.\)])\s+(.+)$/gm) || [];
                      if (optionMatches.length >= 2 && buttonOptions.length === 0) {
                        for (const line of optionMatches.slice(0, 3)) {
                          const cleanOpt = line.replace(/^(?:[1-3]️⃣|[1-3][\.\)])\s+/, "").trim().slice(0, 20);
                          if (cleanOpt) {
                            buttonOptions.push({
                              id: `opt_${buttonOptions.length + 1}`,
                              title: cleanOpt,
                            });
                          }
                        }
                      }
                      if (msgText) replySegments.push(msgText);
                      const upcoming = nextNodeAfter(currentNode.id);
                      if (upcoming && (upcoming.type === "condition" || upcoming.type === "form")) {
                        awaitingNextReplyNodeId = upcoming.id || "";
                        break;
                      }
                      currentNode = upcoming;
                    } else if (currentNode.type === "form") {
                      replySegments.push(
                        `📝 ${currentNode.title || "Quick Details"}:\n${currentNode.description || "Please reply with your details to proceed."}`,
                      );
                      awaitingNextReplyNodeId = currentNode.id || "";
                      break;
                    } else if (currentNode.type === "condition") {
                      // Wait for reply if we just entered this condition in the same turn
                      awaitingNextReplyNodeId = currentNode.id || "";
                      break;
                    } else if (currentNode.type === "action") {
                      if (lowerNodeText.includes("razorpay") || lowerNodeText.includes("payment")) {
                        const amountMatch = lowerNodeText.match(/\b(\d{2,6})\b/);
                        const amount = amountMatch ? Number(amountMatch[1]) : 999;
                        try {
                          const payLink = await createRazorpayPaymentLinkForOrg(ownerId, {
                            amount,
                            currency: "INR",
                            description: matchedFlow.name,
                            customerName: profileName || "Customer",
                            customerPhone: from,
                          });
                          flowCtx.paymentLink = payLink.shortUrl;
                          replySegments.push(`💳 Secure Razorpay Payment Link (₹${amount}):\n${payLink.shortUrl}`);
                        } catch {
                          /* Razorpay not connected yet */
                        }
                      }
                      if (lowerNodeText.includes("calendar") || lowerNodeText.includes("calendly") || lowerNodeText.includes("book")) {
                        try {
                          const cal = await bookConnectedCalendars(ownerId, {
                            title: matchedFlow.name,
                            durationMinutes: 30,
                            customerName: profileName || "Customer",
                            customerPhone: from,
                          });
                          const calUrl = cal.calendlyLink || cal.calendarHtmlLink || "";
                          if (calUrl) {
                            flowCtx.calendlyLink = calUrl;
                            replySegments.push(`📅 Book your slot here:\n${calUrl}`);
                          }
                        } catch {
                          /* Calendar not connected yet */
                        }
                      }
                      if (lowerNodeText.includes("crm") || lowerNodeText.includes("hubspot") || lowerNodeText.includes("zoho") || lowerNodeText.includes("sheet")) {
                        void syncLeadToConnectedCrms(ownerId, {
                          contactName: profileName || "WhatsApp Customer",
                          contactPhone: from,
                          stage: "WhatsApp Flow Triggered",
                          tag: matchedFlow.name,
                          summary: content,
                        }).catch(() => undefined);
                      }
                      if (lowerNodeText.includes("slack")) {
                        void notifyConnectedSlack(
                          ownerId,
                          `💬 *WhatsApp Flow "${matchedFlow.name}" triggered* by ${profileName || from}: "${content}"`,
                        ).catch(() => undefined);
                      }
                      if (lowerNodeText.includes("voice") || lowerNodeText.includes("call")) {
                        void initiateVoiceCallForWhatsAppContact(ownerId, {
                          contactPhone: from,
                          contactName: profileName || conversation.contactName || "Customer",
                          voiceAgentId: activeCustomAgent?.voiceAgentId || agentConfig?.voiceAgentId,
                          conversationId: String(conversation._id),
                        }).catch((err) => {
                          console.warn("[WhatsApp Flow] Voice call trigger skipped:", err instanceof Error ? err.message : err);
                        });
                      }
                      if (lowerNodeText.includes("support case") || lowerNodeText.includes("open case") || lowerNodeText.includes("ticket")) {
                        try {
                          const newCase = await createSupportCaseForContact({
                            ownerId,
                            conversationId: String(conversation._id),
                            contactPhone: from,
                            contactName: profileName || conversation.contactName || "Customer",
                            subject: `${matchedFlow.name}: ${content.slice(0, 80)}`,
                            category: currentNode.title || "WhatsApp Support",
                            notes: Object.values(flowCtx).join(" | "),
                          });
                          flowCtx.caseNumber = newCase.caseNumber;
                          replySegments.push(`🎫 Support Case Created: *${newCase.caseNumber}*\nStatus: Open — Our team has received your case. Reply "${newCase.caseNumber}" anytime to check status.`);
                        } catch {
                          /* Non-fatal if case logging fails */
                        }
                      }
                      if (lowerNodeText.includes("handover") || lowerNodeText.includes("human") || lowerNodeText.includes("takeover")) {
                        switchToHuman = true;
                      }
                      currentNode = nextNodeAfter(currentNode.id);
                    } else {
                      currentNode = nextNodeAfter(currentNode.id);
                    }
                  }

                  let flowReply = replySegments.join("\n\n").trim() ||
                    `Thank you for inquiring about ${matchedFlow.name}! How can our team assist you today?`;
                  if (flowCtx.paymentLink) {
                    flowReply = flowReply.replace(/\{\{\s*paymentLink\s*\}\}/gi, flowCtx.paymentLink);
                  }
                  if (flowCtx.calendlyLink) {
                    flowReply = flowReply.replace(/\{\{\s*calendlyLink\s*\}\}/gi, flowCtx.calendlyLink);
                  }
                  if (flowCtx.caseNumber) {
                    flowReply = flowReply.replace(/\{\{\s*caseNumber\s*\}\}/gi, flowCtx.caseNumber);
                  }

                  const sendOptions: Parameters<typeof sendWhatsAppMessage>[3] =
                    buttonOptions.length >= 2 && flowReply.length <= 1024
                      ? {
                        type: "interactive",
                        interactive: {
                          type: "button",
                          body: { text: flowReply },
                          action: {
                            buttons: buttonOptions.map((b) => ({
                              type: "reply",
                              reply: b,
                            })),
                          },
                        },
                      }
                      : { type: "text", text: flowReply };

                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    sendOptions,
                  );

                  await WhatsAppMessageModel.create({
                    ownerId,
                    conversationId: conversation._id,
                    direction: "outbound",
                    senderPhone: "Vozon Flow Automation",
                    recipientPhone: from,
                    type: sendOptions.type === "interactive" ? "interactive" : "text",
                    content: flowReply,
                    status: "delivered",
                    metaMessageId: sendResult.messageId,
                  });

                  conversation.activeFlowId = awaitingNextReplyNodeId ? String(matchedFlow._id) : "";
                  conversation.activeFlowNodeId = awaitingNextReplyNodeId;
                  conversation.activeFlowContext = awaitingNextReplyNodeId ? flowCtx : {};
                  if (switchToHuman) conversation.mode = "human";
                  conversation.lastMessageText = flowReply;
                  conversation.lastMessageTimestamp = new Date();
                  await conversation.save();
                  continue;
                }

                // 4c. Production Multi-Turn Conversational AI Auto-Reply
                const resolvedWelcome =
                  activeCustomAgent?.welcomeMessage || agentConfig?.welcomeMessage || "";
                const resolvedSenderLabel =
                  activeCustomAgent?.name || "Vozon AI Assistant";

                if (isNewConversation && resolvedWelcome && !handoffAnnounceMessage) {
                  const welcomeMsg = resolvedWelcome;
                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    { type: "text", text: welcomeMsg },
                  );

                  await WhatsAppMessageModel.create({
                    ownerId,
                    conversationId: conversation._id,
                    direction: "outbound",
                    senderPhone: resolvedSenderLabel,
                    recipientPhone: from,
                    type: "text",
                    content: welcomeMsg,
                    status: "delivered",
                    metaMessageId: sendResult.messageId,
                  });

                  conversation.lastMessageText = welcomeMsg;
                  conversation.lastMessageTimestamp = new Date();
                  await conversation.save();
                } else {
                  const rawAiReply = await generateWhatsAppAiReply({
                    ownerId,
                    conversationId: String(conversation._id),
                    contactName: profileName || conversation.contactName || "Customer",
                    userMessage: content,
                    voiceAgentId: activeCustomAgent?.voiceAgentId || agentConfig?.voiceAgentId,
                    welcomeMessage: resolvedWelcome,
                    customAgentName: activeCustomAgent?.name,
                    customAgentRole: activeCustomAgent?.role,
                    systemPrompt: activeCustomAgent?.systemPrompt,
                    knowledgeText: activeCustomAgent?.knowledgeText,
                    language: activeCustomAgent?.language,
                    tone: activeCustomAgent?.tone,
                    allowCallback: activeCustomAgent?.allowCallback,
                  });
                  const aiReply = handoffAnnounceMessage
                    ? `${handoffAnnounceMessage}\n\n${rawAiReply}`
                    : rawAiReply;

                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    { type: "text", text: aiReply },
                  );

                  await WhatsAppMessageModel.create({
                    ownerId,
                    conversationId: conversation._id,
                    direction: "outbound",
                    senderPhone: resolvedSenderLabel,
                    recipientPhone: from,
                    type: "text",
                    content: aiReply,
                    status: "delivered",
                    metaMessageId: sendResult.messageId,
                  });

                  conversation.lastMessageText = aiReply;
                  conversation.lastMessageTimestamp = new Date();
                  await conversation.save();
                }
              }
            } catch (aiErr) {
              console.warn("[WhatsApp Webhook] Automated AI reply error:", aiErr);
            }
          }
        }
      }
    }
  }
}
