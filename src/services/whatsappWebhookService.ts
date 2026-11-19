import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { cleanPhoneNumber, sendWhatsAppMessage } from "./whatsappService.js";
import { AutomationModel, AutomationRunModel } from "../models/Automation.js";
import { processAutomationRuns } from "./automationRuntimeService.js";
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
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppFlowModel,
  WhatsAppAgentConfigModel,
  WhatsAppCampaignModel,
  WhatsAppFormModel,
  WhatsAppFormSubmissionModel,
} from "../models/WhatsAppEntities.js";

type RawWebhookValue = {
  messaging_product?: string;
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
        // Integration not found or inactive; continue to prevent webhook dropping
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
              },
              $setOnInsert: {
                ownerId,
                phoneNumber: from,
                name: profileName || "WhatsApp Customer",
                status: "subscribed",
                tags: ["Inbound"],
              },
            },
            { upsert: true, new: true },
          );

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
          // 3b. Trigger matching live Unified Automation Workflows
          // ----------------------------------------------------
          try {
            const liveAutomations = await AutomationModel.find({
              ownerId,
              status: "live",
              published: { $ne: null },
            });
            for (const flowDoc of liveAutomations) {
              const graph = flowDoc.published as { nodes?: Array<{ id: string; type: string; config: Record<string, string> }> };
              const trigger = graph?.nodes?.find((n) => n.type === "trigger");
              if (trigger && trigger.config.event === "whatsapp_inbound") {
                const keyword = (trigger.config.keyword || "").trim().toLowerCase();
                if (!keyword || content.toLowerCase().includes(keyword)) {
                  const existingActive = await AutomationRunModel.exists({
                    ownerId,
                    automationId: flowDoc._id,
                    contactPhone: from,
                    status: { $in: ["queued", "running", "waiting"] },
                  });
                  if (!existingActive) {
                    const eventId = `wa_msg:${from}:${Date.now()}`;
                    await AutomationRunModel.create({
                      ownerId,
                      automationId: flowDoc._id,
                      version: flowDoc.publishedVersion,
                      graph,
                      eventId,
                      contactName: profileName || "WhatsApp Customer",
                      contactPhone: from,
                      status: "queued",
                      currentNodeId: trigger.id,
                      context: {
                        consentConfirmed: true,
                        source: "whatsapp_inbound",
                        whatsappReply: content,
                        lastMessageText: content,
                        recipientPhoneNumberId: phoneNumberId,
                      },
                    });
                    void processAutomationRuns().catch(() => undefined);
                  } else {
                    await AutomationRunModel.updateMany(
                      {
                        ownerId,
                        automationId: flowDoc._id,
                        contactPhone: from,
                        status: { $in: ["queued", "waiting"] },
                      },
                      {
                        $set: {
                          "context.whatsappReply": content,
                          "context.lastMessageText": content,
                        },
                      },
                    );
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
              const agentConfig = await WhatsAppAgentConfigModel.findOne({ ownerId });

              if (agentConfig && agentConfig.enabled && agentConfig.autoReply) {
                const lowerContent = content.toLowerCase();

                // 4a. Check for Human Handover Transfer Keywords
                const transferKeywords = (agentConfig.transferKeywords || []).map((k) =>
                  String(k).trim().toLowerCase(),
                );
                const isTransfer = transferKeywords.some(
                  (kw) => kw.length > 0 && lowerContent.includes(kw),
                );

                if (isTransfer) {
                  conversation.mode = "human";
                  await conversation.save();

                  const handoverMsg =
                    agentConfig.fallbackMessage ||
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
                    senderPhone: "Vozon AI Assistant",
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
                const activeFlows = await WhatsAppFlowModel.find({ ownerId, status: "active" });
                const resumedFlow = conversation.activeFlowId
                  ? activeFlows.find((f) => String(f._id) === conversation.activeFlowId)
                  : undefined;
                const matchedFlow =
                  resumedFlow ||
                  activeFlows.find(
                    (flow) =>
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
                          voiceAgentId: agentConfig.voiceAgentId,
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
                if (isNewConversation && agentConfig.welcomeMessage) {
                  const welcomeMsg = agentConfig.welcomeMessage;
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
                    senderPhone: "Vozon AI Assistant",
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
                  const aiReply = await generateWhatsAppAiReply({
                    ownerId,
                    conversationId: String(conversation._id),
                    contactName: profileName || conversation.contactName || "Customer",
                    userMessage: content,
                    voiceAgentId: agentConfig.voiceAgentId,
                    welcomeMessage: agentConfig.welcomeMessage,
                  });

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
                    senderPhone: "Vozon AI Assistant",
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
