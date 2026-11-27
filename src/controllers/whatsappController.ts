import type { Request, Response } from "express";
import { recordAutomationWhatsAppStatuses, verifyWhatsAppSignature } from "../services/automationWhatsAppStatusService.js";
import { processWhatsAppInboundWebhook } from "../services/whatsappWebhookService.js";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";
import { env } from "../config/env.js";
import {
  exchangeEmbeddedSignupCode,
  getBusinessPortfolios,
  getWabaIdsFromToken,
  getWabaPhoneNumbers,
  getWhatsAppAppWebhookSubscriptionStatus,
  getWhatsAppPhoneDetails,
  registerPhoneNumber,
  sendWhatsAppMessage,
  subscribeWabaApp,
  triggerCoexistenceSync,
} from "../services/whatsappService.js";

function orgId(request: AuthenticatedRequest): string {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

const wabaWebhookSubscriptionCache = new Map<string, { checkedAt: number; subscribed: boolean }>();

async function ensureWabaWebhookSubscription(wabaId: string, encryptedToken: string, forceRefresh = false) {
  const normalizedWabaId = wabaId.trim();
  if (!normalizedWabaId || !encryptedToken) return false;
  const cached = wabaWebhookSubscriptionCache.get(normalizedWabaId);
  if (!forceRefresh && cached && Date.now() - cached.checkedAt < 60_000) return cached.subscribed;

  let subscribed = false;
  try {
    subscribed = await subscribeWabaApp(normalizedWabaId, decryptSecret(encryptedToken));
  } catch (error) {
    console.warn("Could not subscribe WhatsApp webhook to WABA:", error instanceof Error ? error.message : error);
  }
  wabaWebhookSubscriptionCache.set(normalizedWabaId, { checkedAt: Date.now(), subscribed });
  return subscribed;
}

/**
 * Handles the Embedded Signup callback from the frontend popup.
 * Exchanges the code, registers the phone, subscribes the webhook, and stores the credentials.
 */
export async function handleEmbeddedSignup(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const {
    code,
    wabaId,
    phoneNumberId,
    businessId,
    accessToken: directAccessToken,
    pin,
    label,
    setAsPrimary,
    isCoexistence,
    signupEvent,
  } = request.body as {
    code?: string;
    wabaId?: string;
    phoneNumberId?: string;
    businessId?: string;
    accessToken?: string;
    pin?: string;
    label?: string;
    setAsPrimary?: boolean;
    isCoexistence?: boolean;
    signupEvent?: string;
  };
  const coexistence = Boolean(isCoexistence || signupEvent === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");

  let accessToken = directAccessToken?.trim();
  if (!accessToken) {
    if (!code?.trim()) {
      throw new HttpError(400, "Authorization code or access token is required.");
    }
    // Exchange OAuth code for permanent access token
    accessToken = await exchangeEmbeddedSignupCode(code.trim());
  }

  // Resolve the business portfolio selected in Embedded Signup. This is a
  // business_management API call; keep WhatsApp onboarding available if the
  // permission has not yet been granted to this app.
  let businessPortfolio: { id: string; name: string } | undefined;
  try {
    const portfolios = await getBusinessPortfolios(accessToken);
    const selectedBusinessId = businessId?.trim();
    if (selectedBusinessId) {
      businessPortfolio = portfolios.find((portfolio) => portfolio.id === selectedBusinessId);
    } else if (portfolios.length === 1) {
      businessPortfolio = portfolios[0];
    }
  } catch (err) {
    console.warn(
      "Could not verify the selected Meta business portfolio; continuing WhatsApp setup:",
      err instanceof Error ? err.message : err,
    );
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

  // Discover all phone numbers on the WABA
  let wabaPhoneNumbers: Array<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; code_verification_status?: string }> = [];
  if (finalWabaId) {
    try {
      wabaPhoneNumbers = await getWabaPhoneNumbers(finalWabaId, accessToken);
    } catch {
      wabaPhoneNumbers = [];
    }
  }

  // If Phone Number ID wasn't captured from popup postMessage, pick the first discovered number from the WABA
  if (!finalPhoneNumberId && wabaPhoneNumbers.length > 0) {
    finalPhoneNumberId = wabaPhoneNumbers[0].id;
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

  // 3. Register phone number on Cloud API (skipped for Coexistence — Meta manages registration on the WhatsApp Business app)
  if (!coexistence) {
    try {
      await registerPhoneNumber(finalPhoneNumberId, accessToken, pin?.trim() || "123456");
    } catch (err) {
      console.warn("Phone registration call returned error, proceeding with subscription:", err);
    }
  }

  // 4. Subscribe webhook to the WABA so inbound messages & coexistence echoes reach Vozon
  try {
    await subscribeWabaApp(finalWabaId, accessToken);
  } catch (err) {
    console.warn("Webhook subscription returned warning:", err);
  }

  // 4b. For Coexistence onboarding, trigger one-time contacts & 180-day history sync (best-effort within 24h window)
  let coexistenceSync: { contactsSyncRequested: boolean; historySyncRequested: boolean; errors: string[] } | undefined;
  if (coexistence) {
    try {
      coexistenceSync = await triggerCoexistenceSync(finalPhoneNumberId, accessToken);
    } catch (err) {
      console.warn("Coexistence smb_app_data sync call returned warning:", err);
    }
  }

  // 5. Store in database encrypted with AES-256 (supports multiple WhatsApp numbers per workspace)
  const existingAccounts = await ProviderIntegrationModel.find({
    ownerId,
    provider: "whatsapp",
    status: "connected",
  });

  const isFirstAccount = existingAccounts.length === 0;
  const shouldBePrimary = Boolean(setAsPrimary || isFirstAccount);

  if (shouldBePrimary && existingAccounts.length > 0) {
    await ProviderIntegrationModel.updateMany(
      { ownerId, provider: "whatsapp" },
      { $set: { "metadata.isPrimary": false } },
    );
  }

  const existingMatch = existingAccounts.find((acc) => acc.accountId === finalPhoneNumberId);
  const existingLabel = (existingMatch?.metadata as Record<string, unknown> | undefined)?.label as string | undefined;

  const existingMeta = (existingMatch?.metadata as Record<string, unknown> | undefined) ?? {};
  const secretEncrypted = encryptSecret(accessToken);
  const integrationMetadata: Record<string, unknown> = {
    wabaId: finalWabaId,
    phoneNumberId: finalPhoneNumberId,
    displayPhoneNumber: phoneDetails.displayPhoneNumber || finalPhoneNumberId,
    verifiedName: phoneDetails.verifiedName,
    qualityRating: phoneDetails.qualityRating,
    codeVerificationStatus: phoneDetails.codeVerificationStatus,
    label: label?.trim() || existingLabel || (isFirstAccount ? "Primary Line" : `Line ${existingAccounts.length + 1}`),
    isPrimary: shouldBePrimary || Boolean(existingMeta.isPrimary),
    coexistence: coexistence || Boolean(existingMeta.coexistence),
    ...(coexistenceSync ? { coexistenceSyncRequestedAt: new Date().toISOString() } : {}),
  };
  if (businessPortfolio) {
    integrationMetadata.businessId = businessPortfolio.id;
    integrationMetadata.businessName = businessPortfolio.name;
  }

  // Upsert by { ownerId, provider: "whatsapp", accountId: finalPhoneNumberId } so additional numbers don't overwrite existing ones
  await ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider: "whatsapp", accountId: finalPhoneNumberId },
    {
      $set: {
        accountId: finalPhoneNumberId,
        secretEncrypted,
        status: "connected",
        lastVerifiedAt: new Date(),
        metadata: integrationMetadata,
      },
    },
    { upsert: true, new: true },
  );

  // If the WABA has additional phone numbers discovered during Embedded Signup (and user didn't manually restrict to 1), auto-link them too
  if (!phoneNumberId?.trim() && wabaPhoneNumbers.length > 1) {
    for (let idx = 0; idx < wabaPhoneNumbers.length; idx++) {
      const extra = wabaPhoneNumbers[idx];
      if (!extra?.id || extra.id === finalPhoneNumberId) continue;
      const alreadyExists = existingAccounts.some((acc) => acc.accountId === extra.id);
      if (alreadyExists) continue;
      await ProviderIntegrationModel.findOneAndUpdate(
        { ownerId, provider: "whatsapp", accountId: extra.id },
        {
          $set: {
            accountId: extra.id,
            secretEncrypted,
            status: "connected",
            lastVerifiedAt: new Date(),
            metadata: {
              wabaId: finalWabaId,
              phoneNumberId: extra.id,
              displayPhoneNumber: extra.display_phone_number || extra.id,
              verifiedName: extra.verified_name || phoneDetails.verifiedName,
              qualityRating: extra.quality_rating || "GREEN",
              codeVerificationStatus: extra.code_verification_status || "VERIFIED",
              label: extra.verified_name || `Line ${existingAccounts.length + idx + 1}`,
              isPrimary: false,
              ...(businessPortfolio ? { businessId: businessPortfolio.id, businessName: businessPortfolio.name } : {}),
            },
          },
        },
        { upsert: true, new: true },
      );
    }
  }

  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: true,
    message: coexistence
      ? "WhatsApp Business App Coexistence connected successfully."
      : "WhatsApp Business number connected successfully.",
    phoneDetails: {
      wabaId: finalWabaId,
      phoneNumberId: finalPhoneNumberId,
      displayPhoneNumber: phoneDetails.displayPhoneNumber,
      verifiedName: phoneDetails.verifiedName,
      label: integrationMetadata.label,
      isPrimary: integrationMetadata.isPrimary,
      coexistence: integrationMetadata.coexistence,
    },
    ...(coexistenceSync ? { coexistenceSync } : {}),
  });
}

/**
 * Manually triggers Meta's Coexistence smb_app_data sync (contacts + 180-day chat history)
 * for a connected WhatsApp Business App number (valid within 24h of onboarding).
 */
export async function syncWhatsAppCoexistenceData(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { phoneNumberId } = (request.body || {}) as { phoneNumberId?: string };

  const integrations = await ProviderIntegrationModel.find({
    ownerId,
    provider: "whatsapp",
    status: "connected",
  }).select("+secretEncrypted");

  if (integrations.length === 0) {
    throw new HttpError(400, "WhatsApp is not connected for this organization.");
  }

  const integration =
    (phoneNumberId?.trim()
      ? integrations.find((item) => item.accountId === phoneNumberId.trim())
      : undefined) ||
    integrations.find((item) => Boolean((item.metadata as Record<string, unknown> | undefined)?.coexistence)) ||
    integrations.find((item) => Boolean((item.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
    integrations[0];

  if (!integration || !integration.secretEncrypted) {
    throw new HttpError(404, "Selected WhatsApp number credentials could not be loaded.");
  }

  const accessToken = decryptSecret(integration.secretEncrypted);
  const syncResult = await triggerCoexistenceSync(integration.accountId, accessToken);

  integration.metadata = {
    ...((integration.metadata ?? {}) as Record<string, unknown>),
    coexistence: true,
    coexistenceSyncRequestedAt: new Date().toISOString(),
  };
  integration.markModified("metadata");
  await integration.save();
  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: syncResult.contactsSyncRequested || syncResult.historySyncRequested,
    phoneNumberId: integration.accountId,
    ...syncResult,
  });
}

/**
 * Returns the current WhatsApp connection status and all connected numbers for the organization.
 */
export async function getWhatsAppStatus(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const forceWebhookRefresh = request.query.refresh === "true";
  const integrations = await ProviderIntegrationModel.find({
    ownerId,
    provider: "whatsapp",
    status: "connected",
  }).select("+secretEncrypted").sort({ createdAt: 1 });

  if (integrations.length === 0) {
    response.status(200).json({
      connected: false,
      status: "disconnected",
      metadata: {},
      accounts: [],
      webhook: {
        subscribed: false,
        receiverReady: Boolean(env.metaAppSecret),
        callbackUrl: `${env.backendPublicUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`,
      },
    });
    return;
  }

  const primary =
    integrations.find((item) => Boolean((item.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
    integrations[0];

  const accounts = integrations.map((item, idx) => {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    return {
      accountId: item.accountId,
      phoneNumberId: String(meta.phoneNumberId || item.accountId),
      wabaId: String(meta.wabaId || ""),
      displayPhoneNumber: String(meta.displayPhoneNumber || item.accountId),
      verifiedName: String(meta.verifiedName || "WhatsApp Business"),
      qualityRating: String(meta.qualityRating || "GREEN"),
      codeVerificationStatus: String(meta.codeVerificationStatus || "VERIFIED"),
      businessId: meta.businessId ? String(meta.businessId) : undefined,
      businessName: meta.businessName ? String(meta.businessName) : undefined,
      label: String(meta.label || (idx === 0 ? "Primary Line" : `Line ${idx + 1}`)),
      isPrimary: item.accountId === primary.accountId,
      coexistence: Boolean(meta.coexistence),
      lastVerifiedAt: item.lastVerifiedAt,
    };
  });

  const uniqueWabas = new Map<string, string>();
  for (const integration of integrations) {
    const meta = (integration.metadata ?? {}) as Record<string, unknown>;
    const wabaId = String(meta.wabaId || "").trim();
    if (wabaId && !uniqueWabas.has(wabaId)) {
      uniqueWabas.set(wabaId, integration.secretEncrypted || "");
    }
  }
  const subscriptionStates = await Promise.all(
    [...uniqueWabas].map(([wabaId, encryptedToken]) => ensureWabaWebhookSubscription(wabaId, encryptedToken, forceWebhookRefresh)),
  );
  const appWebhookStatus = await getWhatsAppAppWebhookSubscriptionStatus(forceWebhookRefresh);
  const hasCoexistenceAccount = accounts.some((acc) => acc.coexistence);

  response.status(200).json({
    connected: true,
    status: primary.status,
    accountId: primary.accountId,
    lastVerifiedAt: primary.lastVerifiedAt,
    metadata: primary.metadata ?? {},
    accounts,
    webhook: {
      subscribed: appWebhookStatus.subscribed && subscriptionStates.length > 0 && subscriptionStates.every(Boolean),
      coexistenceSubscribed: !hasCoexistenceAccount || (appWebhookStatus.coexistenceSubscribed && subscriptionStates.length > 0 && subscriptionStates.every(Boolean)),
      missingCoexistenceFields: hasCoexistenceAccount ? appWebhookStatus.missingCoexistenceFields : [],
      receiverReady: Boolean(env.metaAppSecret),
      callbackUrl: `${env.backendPublicUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`,
    },
  });
}

/**
 * Updates a connected WhatsApp number's label or sets it as the primary default number.
 */
export async function updateWhatsAppAccount(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { phoneNumberId } = request.params;
  const { label, isPrimary } = request.body as { label?: string; isPrimary?: boolean };

  const target = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "whatsapp",
    accountId: phoneNumberId,
  });

  if (!target) {
    throw new HttpError(404, "Connected WhatsApp number not found.");
  }

  if (isPrimary) {
    await ProviderIntegrationModel.updateMany(
      { ownerId, provider: "whatsapp" },
      { $set: { "metadata.isPrimary": false } },
    );
  }

  const currentMeta = ((target.metadata ?? {}) as Record<string, unknown>);
  target.metadata = {
    ...currentMeta,
    ...(label !== undefined ? { label: label.trim() || currentMeta.label } : {}),
    ...(isPrimary !== undefined ? { isPrimary: Boolean(isPrimary) } : {}),
  };
  target.markModified("metadata");
  await target.save();

  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: true,
    message: "WhatsApp number settings updated.",
    accountId: target.accountId,
    metadata: target.metadata,
  });
}

/**
 * Sends a test message or appointment confirmation to a target phone number.
 * Supports choosing which connected WhatsApp number (`fromPhoneNumberId`) to send from.
 */
export async function sendWhatsAppTestMessage(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { to, message, fromPhoneNumberId } = request.body as {
    to?: string;
    message?: string;
    fromPhoneNumberId?: string;
  };

  if (!to?.trim()) throw new HttpError(400, "Recipient phone number is required.");

  const integrations = await ProviderIntegrationModel.find({
    ownerId,
    provider: "whatsapp",
    status: "connected",
  }).select("+secretEncrypted");

  if (integrations.length === 0) {
    throw new HttpError(400, "WhatsApp is not connected for this organization. Please connect first.");
  }

  const integration =
    (fromPhoneNumberId?.trim()
      ? integrations.find((i) => i.accountId === fromPhoneNumberId.trim())
      : undefined) ||
    integrations.find((i) => Boolean((i.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
    integrations[0];

  if (!integration || !integration.secretEncrypted) {
    throw new HttpError(400, "Selected WhatsApp number credentials could not be loaded.");
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
    sentFromPhoneNumberId: phoneNumberId,
  });
}

/**
 * Disconnects a specific WhatsApp number (if phoneNumberId is provided) or all WhatsApp numbers for the organization.
 */
export async function disconnectWhatsApp(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const phoneNumberId =
    (typeof request.query.phoneNumberId === "string" ? request.query.phoneNumberId.trim() : "") ||
    (typeof (request.body as Record<string, unknown> | undefined)?.phoneNumberId === "string"
      ? String((request.body as Record<string, unknown>).phoneNumberId).trim()
      : "");

  if (phoneNumberId) {
    await ProviderIntegrationModel.deleteOne({
      ownerId,
      provider: "whatsapp",
      accountId: phoneNumberId,
    });

    // Ensure at least one remaining number is marked as primary
    const remaining = await ProviderIntegrationModel.find({
      ownerId,
      provider: "whatsapp",
      status: "connected",
    }).sort({ createdAt: 1 });

    if (remaining.length > 0 && !remaining.some((r) => Boolean((r.metadata as Record<string, unknown> | undefined)?.isPrimary))) {
      const first = remaining[0];
      first.metadata = { ...((first.metadata ?? {}) as Record<string, unknown>), isPrimary: true };
      first.markModified("metadata");
      await first.save();
    }
  } else {
    await ProviderIntegrationModel.deleteMany({ ownerId, provider: "whatsapp" });
  }

  await invalidateDashboardCache(ownerId);

  response.status(200).json({
    ok: true,
    message: phoneNumberId
      ? "WhatsApp number disconnected successfully."
      : "WhatsApp disconnected successfully.",
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
export async function receiveWhatsAppWebhook(request: Request, response: Response) {
  if (!env.metaAppSecret) throw new HttpError(503, "WhatsApp webhook verification is not configured.");
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
  if (!verifyWhatsAppSignature(rawBody, String(request.header("x-hub-signature-256") ?? ""), env.metaAppSecret)) throw new HttpError(403, "Invalid WhatsApp webhook signature.");
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "Invalid WhatsApp webhook payload."); }

  // Acknowledge immediately so Meta never times out or retries during AI generation or history backfills.
  response.sendStatus(200);

  setImmediate(() => {
    void (async () => {
      await recordAutomationWhatsAppStatuses(body);
      await processWhatsAppInboundWebhook(body);
    })().catch((error) => {
      console.error("[WhatsApp Webhook] Async processing failed:", error);
    });
  });
}
