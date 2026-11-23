import { env } from "../config/env.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { OrganizationModel } from "../models/Organization.js";
import { UserModel } from "../models/User.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { sendTransactionalEmail } from "./emailService.js";
import {
  balanceExhaustedEmail,
  inactivityNudgeEmail,
  lowBalanceEmail,
  rechargeSuccessEmail,
  userWelcomeEmail,
} from "./emailTemplates.js";

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

async function isDirectPlatformOrganization(orgId: string): Promise<boolean> {
  const org = await OrganizationModel.findById(orgId).select("whiteLabelAccountId").lean();
  return Boolean(org && !org.whiteLabelAccountId);
}

export async function sendUserWelcomeEmail(userId: string, orgId?: string): Promise<boolean> {
  try {
    const user = await UserModel.findById(userId);
    if (!user || user.welcomeEmailSentAt) return false;

    if (orgId) {
      const isDirect = await isDirectPlatformOrganization(orgId);
      if (!isDirect) return false;
    }

    const dashboardUrl = `${env.clientUrl}/dashboard`;
    const emailContent = userWelcomeEmail({
      recipientEmail: user.email,
      recipientName: user.name,
      dashboardUrl,
      freeCredits: "$1.00 USD Free Trial",
    });

    await sendTransactionalEmail({
      userId: user.id,
      to: user.email,
      kind: "welcome",
      ...emailContent,
    });

    await UserModel.updateOne(
      { _id: user._id },
      { $set: { welcomeEmailSentAt: new Date() } },
    );

    return true;
  } catch (error) {
    console.error(`Failed to send welcome email to user ${userId}:`, error);
    return false;
  }
}

export async function sendRechargeSuccessEmail(params: {
  orgId: string;
  amountPaidFormatted: string;
  creditsAdded: number;
  newBalanceCredits: number;
  currency: string;
  invoiceNumber?: string;
}): Promise<boolean> {
  try {
    const isDirect = await isDirectPlatformOrganization(params.orgId);
    if (!isDirect) return false;

    const org = await OrganizationModel.findById(params.orgId).select("ownerUserId").lean();
    if (!org?.ownerUserId) return false;

    const owner = await UserModel.findById(org.ownerUserId).select("name email").lean();
    if (!owner?.email) return false;

    const billingUrl = `${env.clientUrl}/dashboard/billing`;
    const emailContent = rechargeSuccessEmail({
      recipientEmail: owner.email,
      recipientName: owner.name,
      amountPaidFormatted: params.amountPaidFormatted,
      creditsAdded: params.creditsAdded,
      newBalanceCredits: params.newBalanceCredits,
      currency: params.currency,
      invoiceNumber: params.invoiceNumber,
      billingUrl,
    });

    await sendTransactionalEmail({
      userId: String(org.ownerUserId),
      to: owner.email,
      kind: "recharge",
      ...emailContent,
    });

    await resetBalanceAlerts(params.orgId);
    return true;
  } catch (error) {
    console.error(`Failed to send recharge success email for org ${params.orgId}:`, error);
    return false;
  }
}

export async function resetBalanceAlerts(orgId: string): Promise<void> {
  try {
    await CreditWalletModel.updateOne(
      { orgId },
      { $unset: { lowBalanceAlertSentAt: 1, exhaustedAlertSentAt: 1 } },
    );
  } catch (error) {
    console.error(`Failed to reset balance alerts for org ${orgId}:`, error);
  }
}

export async function checkAndTriggerBalanceAlerts(
  orgId: string,
  currentBalanceCredits: number,
  currency = "USD",
): Promise<"exhausted" | "low_balance" | "none"> {
  try {
    const isDirect = await isDirectPlatformOrganization(orgId);
    if (!isDirect) return "none";

    const wallet = await CreditWalletModel.findOne({ orgId }).lean();
    if (!wallet) return "none";

    const org = await OrganizationModel.findById(orgId).select("ownerUserId").lean();
    if (!org?.ownerUserId) return "none";

    const owner = await UserModel.findById(org.ownerUserId).select("name email").lean();
    if (!owner?.email) return "none";

    const now = Date.now();
    const isExhausted = currentBalanceCredits <= 0.05;
    const isLow = !isExhausted && (
      currency === "INR" ? currentBalanceCredits <= 150 : currentBalanceCredits <= 2.0
    );

    const rechargeUrl = `${env.clientUrl}/dashboard/billing`;

    if (isExhausted) {
      const lastSent = wallet.exhaustedAlertSentAt ? new Date(wallet.exhaustedAlertSentAt).getTime() : 0;
      if (!lastSent || now - lastSent > ALERT_COOLDOWN_MS) {
        const emailContent = balanceExhaustedEmail({
          recipientEmail: owner.email,
          recipientName: owner.name,
          currency,
          rechargeUrl,
        });

        await sendTransactionalEmail({
          userId: String(org.ownerUserId),
          to: owner.email,
          kind: "balance-exhausted",
          ...emailContent,
        });

        await CreditWalletModel.updateOne(
          { orgId },
          { $set: { exhaustedAlertSentAt: new Date() } },
        );
        return "exhausted";
      }
    } else if (isLow) {
      const lastSent = wallet.lowBalanceAlertSentAt ? new Date(wallet.lowBalanceAlertSentAt).getTime() : 0;
      if (!lastSent || now - lastSent > ALERT_COOLDOWN_MS) {
        const emailContent = lowBalanceEmail({
          recipientEmail: owner.email,
          recipientName: owner.name,
          currentBalanceCredits,
          currency,
          rechargeUrl,
        });

        await sendTransactionalEmail({
          userId: String(org.ownerUserId),
          to: owner.email,
          kind: "low-balance",
          ...emailContent,
        });

        await CreditWalletModel.updateOne(
          { orgId },
          { $set: { lowBalanceAlertSentAt: new Date() } },
        );
        return "low_balance";
      }
    }

    return "none";
  } catch (error) {
    console.error(`Failed to evaluate balance alerts for org ${orgId}:`, error);
    return "none";
  }
}

export async function processInactivityNudges(): Promise<number> {
  try {
    const now = Date.now();
    const minAge = new Date(now - 48 * 60 * 60 * 1000); // at least 48 hours old
    const maxAge = new Date(now - 7 * 24 * 60 * 60 * 1000); // no older than 7 days

    const inactiveUsers = await UserModel.find({
      createdAt: { $gte: maxAge, $lte: minAge },
      inactivityNudgeSentAt: { $exists: false },
    }).limit(20);

    let nudgedCount = 0;
    for (const user of inactiveUsers) {
      const org = await OrganizationModel.findOne({ ownerUserId: user._id }).lean();
      if (!org || org.whiteLabelAccountId) continue;

      const agentCount = await VoiceAgentModel.countDocuments({ ownerId: org._id });
      const callCount = await CallDetailRecordModel.countDocuments({ ownerId: org._id });

      // If user has not created any voice agent or has zero calls
      if (agentCount === 0 || callCount === 0) {
        const createAgentUrl = `${env.clientUrl}/dashboard/agents/create`;
        const emailContent = inactivityNudgeEmail({
          recipientEmail: user.email,
          recipientName: user.name,
          createAgentUrl,
        });

        await sendTransactionalEmail({
          userId: user.id,
          to: user.email,
          kind: "nudge",
          ...emailContent,
        });

        await UserModel.updateOne(
          { _id: user._id },
          { $set: { inactivityNudgeSentAt: new Date() } },
        );
        nudgedCount++;
      }
    }

    return nudgedCount;
  } catch (error) {
    console.error("Error processing inactivity nudges:", error);
    return 0;
  }
}
