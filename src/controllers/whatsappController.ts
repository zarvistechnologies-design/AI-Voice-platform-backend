import type { Request, Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";
import { env } from "../config/env.js";
import {
  exchangeEmbeddedSignupCode,
  getWabaIdsFromToken,
  getWabaPhoneNumbers,
  getWhatsAppPhoneDetails,
  registerPhoneNumber,
  sendWhatsAppMessage,
  subscribeWabaApp,
} from "../services/whatsappService.js";

function orgId(request: AuthenticatedRequest): string {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

/**
 * Handles the Embedded Signup callback from the frontend popup.
 * Exchanges the code, registers the phone, subscribes the webhook, and stores the credentials.
 */
export async function handleEmbeddedSignup(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { code, wabaId, phoneNumberId, accessToken: directAccessToken } = request.body as {
    code?: string;
    wabaId?: string;
    phoneNumberId?: string;
    accessToken?: string;
  };

  let accessToken = directAccessToken?.trim();
  if (!accessToken) {
    if (!code?.trim()) {
      throw new HttpError(400, "Authorization code or access token is required.");
    }
    // Exchange OAuth code for permanent access token
    accessToken = await exchangeEmbeddedSignupCode(code.trim());
  }

  let finalWabaId = wabaId?.trim();
  let finalPhoneNumberId = phoneNumberId?.trim();

  // If WABA ID wasn't captured from popup postMessage, discover it from the token
  if (!finalWabaId) {
    const discoveredWabas = await getWabaIdsFromToken(accessToken);
    if (discoveredWabas.length > 0) {
      finalWabaId = discoveredWabas[0];
    }
  }

  // If Phone Number ID wasn't captured from popup postMessage, discover it from the WABA
  if (!finalPhoneNumberId && finalWabaId) {
    const phoneNumbers = await getWabaPhoneNumbers(finalWabaId, accessToken);
    if (phoneNumbers.length > 0) {
      finalPhoneNumberId = phoneNumbers[0].id;
    }
  }

  if (!finalWabaId) {
    throw new HttpError(
      400,
      "WhatsApp Business Account ID (wabaId) could not be detected. Please try the signup popup again or enter credentials manually.",
    );
  }
  if (!finalPhoneNumberId) {
    throw new HttpError(
      400,
      "WhatsApp Phone Number ID could not be detected for this account. Please ensure a phone number is added in Meta Business Manager or enter credentials manually.",
    );
  }

  // 2. Fetch phone details (display number, verified name)
  let phoneDetails = {
    displayPhoneNumber: "",
    verifiedName: "",
    codeVerificationStatus: "VERIFIED",
    qualityRating: "UNKNOWN",
  };
  try {
    phoneDetails = await getWhatsAppPhoneDetails(finalPhoneNumberId, accessToken);
  } catch (err) {
    // Non-fatal: if fields aren't immediately populated by Meta, continue registration
    console.warn("Could not immediately fetch phone details from Meta:", err);
  }

  // 3. Register phone number on Cloud API
  try {
    await registerPhoneNumber(finalPhoneNumberId, accessToken);
  } catch (err) {
    console.warn("Phone registration call returned error, proceeding with subscription:", err);
  }

  // 4. Subscribe webhook to the WABA so inbound messages reach Vozon
  try {
    await subscribeWabaApp(finalWabaId, accessToken);
  } catch (err) {
    console.warn("Webhook subscription returned warning:", err);
  }

  // 5. Store in database encrypted with AES-256
  const secretEncrypted = encryptSecret(accessToken);
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider: "whatsapp" },
    {
      $set: {
        accountId: finalPhoneNumberId,
        secretEncrypted,
        status: "connected",
        lastVerifiedAt: new Date(),
        metadata: {
          wabaId: finalWabaId,
          phoneNumberId: finalPhoneNumberId,
          displayPhoneNumber: phoneDetails.displayPhoneNumber || finalPhoneNumberId,
          verifiedName: phoneDetails.verifiedName,
          qualityRating: phoneDetails.qualityRating,
          codeVerificationStatus: phoneDetails.codeVerificationStatus,
        },
      },
    },
    { upsert: true, new: true },
  );

  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: true,
    message: "WhatsApp Business connected successfully.",
    phoneDetails: {
      wabaId: finalWabaId,
      phoneNumberId: finalPhoneNumberId,
      displayPhoneNumber: phoneDetails.displayPhoneNumber,
      verifiedName: phoneDetails.verifiedName,
    },
  });
}

/**
 * Returns the current WhatsApp connection status for the organization.
 */
export async function getWhatsAppStatus(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const integration = await ProviderIntegrationModel.findOne({ ownerId, provider: "whatsapp" });

  if (!integration || integration.status !== "connected") {
    response.status(200).json({
      connected: false,
      status: "disconnected",
      metadata: {},
    });
    return;
  }

  response.status(200).json({
    connected: true,
    status: integration.status,
    accountId: integration.accountId,
    lastVerifiedAt: integration.lastVerifiedAt,
    metadata: integration.metadata ?? {},
  });
}

/**
 * Sends a test message or appointment confirmation to a target phone number.
 * Used for testing and recording the Meta App Review video.
 */
export async function sendWhatsAppTestMessage(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { to, message } = request.body as { to?: string; message?: string };

  if (!to?.trim()) throw new HttpError(400, "Recipient phone number is required.");

  const integration = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "whatsapp",
  }).select("+secretEncrypted");

  if (!integration || !integration.secretEncrypted) {
    throw new HttpError(400, "WhatsApp is not connected for this organization. Please connect first.");
  }

  const accessToken = decryptSecret(integration.secretEncrypted);
  const phoneNumberId = integration.accountId;

  const defaultText =
    message?.trim() ||
    `✅ *Appointment Confirmation - Vozon Health*\n\nHello! Your appointment has been scheduled successfully.\n\n📅 Date: Tomorrow\n⏰ Time: 11:30 AM\n📍 Clinic: Main Branch\n\nReply to this message if you need to reschedule.`;

  const result = await sendWhatsAppMessage(phoneNumberId, accessToken, to.trim(), {
    type: "text",
    text: defaultText,
  });

  response.status(200).json({
    ok: true,
    messageId: result.messageId,
    sentTo: to.trim(),
  });
}

/**
 * Disconnects the WhatsApp integration for the organization.
 */
export async function disconnectWhatsApp(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "whatsapp" });
  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: true,
    message: "WhatsApp disconnected successfully.",
  });
}

/**
 * Webhook verification endpoint for Meta WhatsApp Cloud API.
 * Handles the GET hub.challenge verification handshake.
 */
export function verifyWhatsAppWebhook(request: Request, response: Response) {
  const mode = request.query["hub.mode"];
  const token = request.query["hub.verify_token"];
  const challenge = request.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsappWebhookVerifyToken) {
    response.status(200).send(challenge);
    return;
  }

  response.status(403).json({ error: "Verification token mismatch." });
}

/**
 * Webhook receiver for incoming WhatsApp messages and delivery statuses.
 */
export function receiveWhatsAppWebhook(request: Request, response: Response) {
  const body = request.body as Record<string, unknown>;

  // Acknowledge receipt immediately as required by Meta (under 3 seconds)
  response.sendStatus(200);

  if (body?.object === "whatsapp_business_account") {
    // Process async in background without blocking response
    const entries = Array.isArray(body.entry) ? (body.entry as Array<Record<string, unknown>>) : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? (entry.changes as Array<Record<string, unknown>>) : [];
      for (const change of changes) {
        const value = change.value as Record<string, unknown> | undefined;
        if (!value) continue;

        const messages = Array.isArray(value.messages) ? (value.messages as Array<Record<string, unknown>>) : [];
        for (const msg of messages) {
          const from = String(msg.from ?? "");
          const type = String(msg.type ?? "");
          console.log(`[WhatsApp Webhook] Inbound message from ${from}, type: ${type}`);
        }
      }
    }
  }
}
