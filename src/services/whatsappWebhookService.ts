import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { cleanPhoneNumber, sendWhatsAppMessage } from "./whatsappService.js";
import {
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppFlowModel,
  WhatsAppAgentConfigModel,
  WhatsAppCampaignModel,
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

          // Update message in database
          await WhatsAppMessageModel.updateOne(
            { metaMessageId: messageId },
            { $set: { status: status as "sent" | "delivered" | "read" | "failed" } },
          );

          // Update campaign metrics if applicable
          if (status === "delivered") {
            await WhatsAppCampaignModel.updateMany(
              { ownerId, status: "completed" },
              { $inc: { "stats.delivered": 1 } },
            );
          } else if (status === "read") {
            await WhatsAppCampaignModel.updateMany(
              { ownerId, status: "completed" },
              { $inc: { "stats.read": 1 } },
            );
          } else if (status === "failed") {
            await WhatsAppCampaignModel.updateMany(
              { ownerId, status: "completed" },
              { $inc: { "stats.failed": 1 } },
            );
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

          // Increment replied count on active campaigns
          await WhatsAppCampaignModel.updateMany(
            { ownerId, status: "completed" },
            { $inc: { "stats.replied": 1 } },
          );

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

                // 4b. Check for Visual Flow Maker Keyword Trigger
                const flows = await WhatsAppFlowModel.find({ ownerId, status: "active" });
                const matchedFlow = flows.find(
                  (flow) =>
                    flow.triggerKeyword &&
                    lowerContent.includes(flow.triggerKeyword.toLowerCase()),
                );

                if (matchedFlow) {
                  matchedFlow.executionCount = (matchedFlow.executionCount || 0) + 1;
                  await matchedFlow.save();

                  const nodes = (Array.isArray(matchedFlow.nodes) ? matchedFlow.nodes : []) as Array<{
                    type?: string;
                    title?: string;
                    description?: string;
                  }>;
                  const messageNode = nodes.find((n) => n.type === "message");
                  const flowReply =
                    messageNode?.description ||
                    `Thank you for inquiring about ${matchedFlow.name}! How can our team assist you today?`;

                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    {
                      type: "text",
                      text: flowReply,
                    },
                  );

                  await WhatsAppMessageModel.create({
                    ownerId,
                    conversationId: conversation._id,
                    direction: "outbound",
                    senderPhone: "Vozon Flow Automation",
                    recipientPhone: from,
                    type: "text",
                    content: flowReply,
                    status: "delivered",
                    metaMessageId: sendResult.messageId,
                  });

                  conversation.lastMessageText = flowReply;
                  conversation.lastMessageTimestamp = new Date();
                  await conversation.save();
                  continue;
                }

                // 4c. General Greeting / Auto-Reply on New Inbound Thread
                if (isNewConversation || (conversation.unreadCount || 0) <= 1) {
                  const welcomeMsg =
                    agentConfig.welcomeMessage ||
                    "👋 Welcome to Vozon AI! How can our intelligent assistant help you today?";

                  const sendResult = await sendWhatsAppMessage(
                    phoneNumberId,
                    accessToken,
                    from,
                    {
                      type: "text",
                      text: welcomeMsg,
                    },
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
