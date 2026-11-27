import { cleanPhoneNumber } from "./whatsappService.js";
import {
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
} from "../models/WhatsAppEntities.js";

export type RawWebhookMessage = {
  from?: string;
  to?: string;
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
  document?: { filename?: string; caption?: string; id?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  video?: { caption?: string; id?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  edit?: { original_message_id?: string; message?: RawWebhookMessage };
  revoke?: { original_message_id?: string };
};

export type RawWebhookContact = {
  profile?: { name?: string };
  wa_id?: string;
};

export type RawWebhookContactSync = {
  action?: string;
  id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  wa_id?: string;
  phones?: Array<{ phone?: string; type?: string }>;
};

export type RawWebhookHistoryThread = {
  thread_id?: string;
  peer_recipient_id?: string;
  messages?: RawWebhookMessage[];
  message_echoes?: RawWebhookMessage[];
};

/** Extracts a human-readable text representation of an incoming or echoed WhatsApp message payload. */
export function extractWhatsAppMessageContent(msg: RawWebhookMessage, emptyFallback = ""): string {
  const type = msg.type || "text";
  switch (type) {
    case "text":
      return msg.text?.body?.trim() || emptyFallback;
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
    case "sticker":
      return "🩷 [Sticker]";
    case "location":
      return msg.location?.name
        ? `📍 ${msg.location.name} (${msg.location.address || ""})`
        : "📍 [Location pin shared]";
    case "revoke":
      return "[Message deleted from mobile app]";
    default:
      return msg.text?.body?.trim() || (type ? `[${type} attachment]` : emptyFallback);
  }
}

/** Extracts Meta Media ID and MIME type for downloadable media attachments. */
export function extractWhatsAppMediaInfo(msg: RawWebhookMessage): { mediaId: string; mediaMimeType: string } {
  const media =
    (msg.type === "image" ? msg.image : undefined) ||
    (msg.type === "document" ? msg.document : undefined) ||
    (msg.type === "audio" ? msg.audio : undefined) ||
    (msg.type === "video" ? msg.video : undefined) ||
    (msg.type === "sticker" ? msg.sticker : undefined) ||
    msg.image ||
    msg.document ||
    msg.audio ||
    msg.video ||
    msg.sticker;
  return {
    mediaId: String(media?.id ?? "").trim(),
    mediaMimeType: String(media?.mime_type ?? "").trim(),
  };
}

/** Maps arbitrary Meta message types into the persisted WhatsAppMessage schema enum. */
export function normalizeStoredWhatsAppMessageType(
  rawType?: string,
): "text" | "template" | "image" | "document" | "interactive" {
  switch (rawType) {
    case "image":
      return "image";
    case "document":
      return "document";
    case "template":
      return "template";
    case "interactive":
    case "button":
      return "interactive";
    default:
      return "text";
  }
}

function parseMetaTimestamp(rawTs?: string): Date {
  const seconds = Number(rawTs);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

function resolveProfileName(
  contactsList: RawWebhookContact[],
  rawWaId?: string,
  cleanedPhone?: string,
): string {
  const match = contactsList.find(
    (c) => (rawWaId && c.wa_id === rawWaId) || (cleanedPhone && c.wa_id && cleanPhoneNumber(c.wa_id) === cleanedPhone),
  );
  return match?.profile?.name?.trim() || "";
}

/**
 * Resolves a WhatsApp conversation scoped by `(ownerId, contactPhone, recipientPhoneNumberId)`
 * so connecting multiple numbers (e.g. Coexistence + Cloud API) never merges separate threads,
 * while safely claiming legacy conversations that have an empty `recipientPhoneNumberId`.
 */
export async function findWhatsAppConversationForLine(
  ownerId: string,
  contactPhone: string,
  phoneNumberId?: string,
) {
  const cleanLineId = String(phoneNumberId ?? "").trim();
  if (cleanLineId) {
    const exact = await WhatsAppConversationModel.findOne({
      ownerId,
      contactPhone,
      recipientPhoneNumberId: cleanLineId,
    });
    if (exact) return exact;

    const legacyUnscoped = await WhatsAppConversationModel.findOne({
      ownerId,
      contactPhone,
      $or: [{ recipientPhoneNumberId: "" }, { recipientPhoneNumberId: { $exists: false } }],
    });
    if (legacyUnscoped) return legacyUnscoped;
    return null;
  }
  return WhatsAppConversationModel.findOne({ ownerId, contactPhone });
}

/** Creates a WhatsApp message while tolerating concurrent duplicate-key retries (`11000`). */
export async function createDedupedWhatsAppMessage(doc: Record<string, unknown>): Promise<boolean> {
  const ownerId = String(doc.ownerId ?? "");
  const metaMessageId = String(doc.metaMessageId ?? "").trim();
  if (metaMessageId) {
    const exists = await WhatsAppMessageModel.exists({ ownerId, metaMessageId });
    if (exists) return false;
  }
  try {
    await WhatsAppMessageModel.create(doc);
    return true;
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code === 11000 && metaMessageId) {
      return false;
    }
    throw err;
  }
}

/** Persists a WhatsApp Business mobile app echo (live, edit/revoke, or historical backfill). */
export async function upsertCoexistenceEcho(params: {
  ownerId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  contactsList: RawWebhookContact[];
  echo: RawWebhookMessage;
  isHistory: boolean;
}): Promise<void> {
  const { ownerId, phoneNumberId, displayPhoneNumber, contactsList, echo, isHistory } = params;
  const recipientPhone = cleanPhoneNumber(String(echo.to ?? ""));
  if (!recipientPhone) return;

  const msgDate = parseMetaTimestamp(echo.timestamp);

  // Handle mobile message revoke (delete for everyone) cleanly on the original message row.
  const revokedOriginalId = String(echo.revoke?.original_message_id ?? "").trim();
  if (revokedOriginalId) {
    const deletedText = "[Message deleted from mobile app]";
    const updated = await WhatsAppMessageModel.findOneAndUpdate(
      { ownerId, metaMessageId: revokedOriginalId },
      { $set: { content: deletedText, deletedAt: msgDate } },
      { new: true },
    );
    if (updated?.conversationId) {
      await WhatsAppConversationModel.updateOne(
        { _id: updated.conversationId, ownerId },
        { $set: { lastMessageText: deletedText } },
      );
    }
    return;
  }

  // Handle mobile message edit cleanly on the original message row.
  const editedOriginalId = String(echo.edit?.original_message_id ?? "").trim();
  if (editedOriginalId) {
    const editedPayload = echo.edit?.message ?? echo;
    const editedText = extractWhatsAppMessageContent(editedPayload, "[Message edited from mobile app]");
    const updated = await WhatsAppMessageModel.findOneAndUpdate(
      { ownerId, metaMessageId: editedOriginalId },
      { $set: { content: editedText, editedAt: msgDate } },
      { new: true },
    );
    if (updated?.conversationId) {
      await WhatsAppConversationModel.updateOne(
        { _id: updated.conversationId, ownerId },
        { $set: { lastMessageText: editedText } },
      );
    }
    return;
  }

  const echoMetaId = String(echo.id ?? "").trim();
  if (echoMetaId) {
    const exists = await WhatsAppMessageModel.exists({ ownerId, metaMessageId: echoMetaId });
    if (exists) return;
  }

  const echoContent = extractWhatsAppMessageContent(echo, "[Mobile message sent]") || "[Mobile message sent]";
  const { mediaId, mediaMimeType } = extractWhatsAppMediaInfo(echo);
  const profileName = resolveProfileName(contactsList, echo.to, recipientPhone);
  const tagToAdd = isHistory ? "Coexistence-History" : "Coexistence-Mobile";

  await WhatsAppContactModel.findOneAndUpdate(
    { ownerId, phoneNumber: recipientPhone },
    {
      $set: {
        lastContactedAt: msgDate,
        ...(profileName ? { name: profileName } : {}),
      },
      $setOnInsert: {
        ownerId,
        phoneNumber: recipientPhone,
        ...(!profileName ? { name: "WhatsApp Customer" } : {}),
        status: "pending_consent",
        tags: [tagToAdd],
      },
    },
    { upsert: true, new: true },
  );

  let conversation = await findWhatsAppConversationForLine(ownerId, recipientPhone, phoneNumberId);

  if (!conversation) {
    conversation = await WhatsAppConversationModel.create({
      ownerId,
      contactPhone: recipientPhone,
      contactName: profileName || "Customer",
      recipientPhoneNumberId: phoneNumberId,
      recipientDisplayPhone: displayPhoneNumber,
      lastMessageText: echoContent,
      lastMessageTimestamp: msgDate,
      unreadCount: 0,
      status: "open",
      // Switch live echoes to human so AI does not override a mobile app reply; keep historical imports in AI mode.
      mode: isHistory ? "ai" : "human",
      tags: [tagToAdd],
    });
  } else {
    const isNewer = !conversation.lastMessageTimestamp || msgDate >= conversation.lastMessageTimestamp;
    if (!isHistory || isNewer) {
      conversation.lastMessageText = echoContent;
      conversation.lastMessageTimestamp = msgDate;
    }
    if (phoneNumberId) conversation.recipientPhoneNumberId = phoneNumberId;
    if (displayPhoneNumber) conversation.recipientDisplayPhone = displayPhoneNumber;
    if (profileName && (!conversation.contactName || conversation.contactName === "Customer")) {
      conversation.contactName = profileName;
    }
    if (!isHistory) {
      conversation.mode = "human";
    }
    if (!Array.isArray(conversation.tags)) {
      conversation.tags = [tagToAdd];
    } else if (!conversation.tags.includes(tagToAdd)) {
      conversation.tags.push(tagToAdd);
    }
    await conversation.save();
  }

  await createDedupedWhatsAppMessage({
    ownerId,
    conversationId: conversation._id,
    direction: "outbound",
    senderPhone: displayPhoneNumber ? `${displayPhoneNumber} (Mobile App)` : "WhatsApp Business Mobile App",
    recipientPhone,
    type: normalizeStoredWhatsAppMessageType(echo.type),
    content: echoContent,
    status: "delivered",
    metaMessageId: echoMetaId,
    mediaId,
    mediaMimeType,
    createdAt: msgDate,
  });
}

/** Syncs mobile WhatsApp Business App contacts from `smb_app_state_sync` webhooks. */
export async function processCoexistenceStateSync(
  ownerId: string,
  contactsSync: RawWebhookContactSync[],
): Promise<void> {
  for (const item of contactsSync) {
    const rawPhone = item.wa_id || item.phones?.[0]?.phone || "";
    const phone = cleanPhoneNumber(String(rawPhone));
    if (!phone) continue;

    const action = String(item.action ?? "ADD").toUpperCase();
    if (action === "REMOVE" || action === "DELETE") continue;

    const fullName =
      [item.first_name, item.last_name]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join(" ") ||
      String(item.full_name ?? "").trim();

    await WhatsAppContactModel.findOneAndUpdate(
      { ownerId, phoneNumber: phone },
      {
        $set: {
          ...(fullName ? { name: fullName } : {}),
        },
        $addToSet: { tags: "Coexistence-Sync" },
        $setOnInsert: {
          ownerId,
          phoneNumber: phone,
          ...(!fullName ? { name: "WhatsApp Customer" } : {}),
          status: "pending_consent",
        },
      },
      { upsert: true, new: true },
    );

    if (fullName) {
      await WhatsAppConversationModel.updateMany(
        {
          ownerId,
          contactPhone: phone,
          contactName: { $in: ["", "Customer", "WhatsApp Customer"] },
        },
        { $set: { contactName: fullName } },
      );
    }
  }
}

/** Ingests historical 1:1 threads from Meta Coexistence `history` webhooks without triggering AI replies. */
export async function processCoexistenceHistory(params: {
  ownerId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  contactsList: RawWebhookContact[];
  threads: RawWebhookHistoryThread[];
}): Promise<void> {
  const { ownerId, phoneNumberId, displayPhoneNumber, contactsList, threads } = params;
  for (const thread of threads) {
    const peerPhone = cleanPhoneNumber(String(thread.peer_recipient_id ?? thread.thread_id ?? ""));
    const inboundList = Array.isArray(thread.messages) ? thread.messages : [];
    const echoList = Array.isArray(thread.message_echoes) ? thread.message_echoes : [];

    for (const msg of inboundList) {
      const from = cleanPhoneNumber(String(msg.from ?? peerPhone));
      if (!from) continue;
      const metaMsgId = String(msg.id ?? "").trim();
      if (metaMsgId) {
        const exists = await WhatsAppMessageModel.exists({ ownerId, metaMessageId: metaMsgId });
        if (exists) continue;
      }

      const content = extractWhatsAppMessageContent(msg);
      if (!content) continue;
      const { mediaId, mediaMimeType } = extractWhatsAppMediaInfo(msg);
      const msgDate = parseMetaTimestamp(msg.timestamp);
      const profileName = resolveProfileName(contactsList, msg.from, from);

      await WhatsAppContactModel.findOneAndUpdate(
        { ownerId, phoneNumber: from },
        {
          $set: {
            ...(profileName ? { name: profileName } : {}),
          },
          $setOnInsert: {
            ownerId,
            phoneNumber: from,
            ...(!profileName ? { name: "WhatsApp Customer" } : {}),
            status: "pending_consent",
            tags: ["Coexistence-History"],
          },
        },
        { upsert: true, new: true },
      );

      let conversation = await findWhatsAppConversationForLine(ownerId, from, phoneNumberId);
      if (!conversation) {
        conversation = await WhatsAppConversationModel.create({
          ownerId,
          contactPhone: from,
          contactName: profileName || "Customer",
          recipientPhoneNumberId: phoneNumberId,
          recipientDisplayPhone: displayPhoneNumber,
          lastMessageText: content,
          lastMessageTimestamp: msgDate,
          unreadCount: 0,
          status: "open",
          mode: "ai",
          tags: ["Coexistence-History"],
        });
      } else {
        const isNewer = !conversation.lastMessageTimestamp || msgDate >= conversation.lastMessageTimestamp;
        if (isNewer) {
          conversation.lastMessageText = content;
          conversation.lastMessageTimestamp = msgDate;
        }
        if (phoneNumberId && !conversation.recipientPhoneNumberId) conversation.recipientPhoneNumberId = phoneNumberId;
        if (displayPhoneNumber && !conversation.recipientDisplayPhone) conversation.recipientDisplayPhone = displayPhoneNumber;
        if (profileName && (!conversation.contactName || conversation.contactName === "Customer")) {
          conversation.contactName = profileName;
        }
        if (!Array.isArray(conversation.tags)) {
          conversation.tags = ["Coexistence-History"];
        } else if (!conversation.tags.includes("Coexistence-History")) {
          conversation.tags.push("Coexistence-History");
        }
        await conversation.save();
      }

      await createDedupedWhatsAppMessage({
        ownerId,
        conversationId: conversation._id,
        direction: "inbound",
        senderPhone: from,
        recipientPhone: phoneNumberId || displayPhoneNumber || "Platform",
        type: normalizeStoredWhatsAppMessageType(msg.type),
        content,
        status: "delivered",
        metaMessageId: metaMsgId,
        mediaId,
        mediaMimeType,
        createdAt: msgDate,
      });
    }

    for (const echo of echoList) {
      const normalizedEcho = echo.to ? echo : { ...echo, to: peerPhone };
      await upsertCoexistenceEcho({
        ownerId,
        phoneNumberId,
        displayPhoneNumber,
        contactsList,
        echo: normalizedEcho,
        isHistory: true,
      });
    }
  }
}
