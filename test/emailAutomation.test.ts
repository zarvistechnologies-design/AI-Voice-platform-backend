import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceExhaustedEmail,
  inactivityNudgeEmail,
  lowBalanceEmail,
  rechargeSuccessEmail,
  userWelcomeEmail,
} from "../src/services/emailTemplates.js";

test("userWelcomeEmail renders personalized welcome message, free trial credits and dashboard link", () => {
  const result = userWelcomeEmail({
    recipientName: "Alex Rivera",
    recipientEmail: "alex@example.com",
    dashboardUrl: "https://app.vozon.ai/dashboard",
    freeCredits: "$1.00 USD Free Trial",
  });

  assert.match(result.subject, /Welcome to Vozon/);
  assert.match(result.text, /Hi Alex Rivera/);
  assert.match(result.text, /\$1\.00 USD Free Trial/);
  assert.match(result.text, /https:\/\/app\.vozon\.ai\/dashboard/);
  assert.match(result.html, /Start building conversational voice AI/);
  assert.match(result.html, /alex@example\.com/);
});

test("rechargeSuccessEmail renders payment amount, added credits, new balance and invoice details", () => {
  const result = rechargeSuccessEmail({
    recipientName: "Devin",
    recipientEmail: "devin@example.com",
    amountPaidFormatted: "$25.00 USD",
    creditsAdded: 25,
    newBalanceCredits: 28.5,
    currency: "USD",
    invoiceNumber: "VZN-PAY12345678",
    billingUrl: "https://app.vozon.ai/dashboard/billing",
  });

  assert.match(result.subject, /Payment Confirmed: \$25\.00 USD added to Vozon/);
  assert.match(result.text, /Credits Added: 25\.00/);
  assert.match(result.text, /Updated Balance: 28\.50 USD/);
  assert.match(result.text, /Invoice Number: VZN-PAY12345678/);
  assert.match(result.html, /Payment Successful/);
  assert.match(result.html, /VZN-PAY12345678/);
});

test("lowBalanceEmail warns user when balance is running low", () => {
  const result = lowBalanceEmail({
    recipientName: "Sam",
    recipientEmail: "sam@example.com",
    currentBalanceCredits: 1.45,
    currency: "USD",
    rechargeUrl: "https://app.vozon.ai/dashboard/billing",
  });

  assert.match(result.subject, /Low Wallet Balance on Vozon \(1\.45 USD\)/);
  assert.match(result.text, /1\.45 USD/);
  assert.match(result.text, /https:\/\/app\.vozon\.ai\/dashboard\/billing/);
  assert.match(result.html, /Your credit balance is low/);
});

test("balanceExhaustedEmail alerts user that calls are paused due to zero credits", () => {
  const result = balanceExhaustedEmail({
    recipientName: "Robin",
    recipientEmail: "robin@example.com",
    currency: "USD",
    rechargeUrl: "https://app.vozon.ai/dashboard/billing",
  });

  assert.match(result.subject, /Credit Balance Exhausted on Vozon/);
  assert.match(result.text, /0\.00 USD/);
  assert.match(result.text, /paused until you recharge/);
  assert.match(result.html, /Wallet Balance Exhausted/);
  assert.match(result.html, /Paused/);
});

test("inactivityNudgeEmail nudges user to create first voice agent with templates", () => {
  const result = inactivityNudgeEmail({
    recipientName: "Morgan",
    recipientEmail: "morgan@example.com",
    createAgentUrl: "https://app.vozon.ai/dashboard/agents/create",
  });

  assert.match(result.subject, /Ready to launch your first AI voice agent/);
  assert.match(result.text, /haven't created your first voice agent yet/);
  assert.match(result.text, /Healthcare & Clinic Receptionist/);
  assert.match(result.html, /Launch your first voice agent in minutes/);
});

test("checkAndTriggerBalanceAlerts triggers exhausted alert when balance is 0.00", async (t) => {
  const { env } = await import("../src/config/env.js");
  const originalResendKey = env.resendApiKey;
  const originalEmailUser = env.emailUser;
  t.after(() => {
    env.resendApiKey = originalResendKey;
    env.emailUser = originalEmailUser;
  });
  env.resendApiKey = "";
  env.emailUser = "";

  const { OrganizationModel } = await import("../src/models/Organization.js");
  const { CreditWalletModel } = await import("../src/models/CreditWallet.js");
  const { UserModel } = await import("../src/models/User.js");
  const { EmailDeliveryModel } = await import("../src/models/EmailDelivery.js");
  const { checkAndTriggerBalanceAlerts } = await import("../src/services/emailAutomationService.js");

  t.mock.method(OrganizationModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ ownerUserId: "user-123", whiteLabelAccountId: undefined }),
    }),
  }));

  t.mock.method(CreditWalletModel, "findOne", () => ({
    lean: async () => ({ orgId: "org-123", balanceCredits: 0, exhaustedAlertSentAt: undefined }),
  }));

  t.mock.method(UserModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ name: "Taylor", email: "taylor@example.com" }),
    }),
  }));

  let walletUpdateCalled = false;
  t.mock.method(CreditWalletModel, "updateOne", async () => {
    walletUpdateCalled = true;
    return { modifiedCount: 1 };
  });

  let emailCreated = false;
  t.mock.method(EmailDeliveryModel, "create", async (input: { kind: string; to: string }) => {
    emailCreated = true;
    assert.equal(input.kind, "balance-exhausted");
    assert.equal(input.to, "taylor@example.com");
    return { ...input, status: "preview" };
  });

  const outcome = await checkAndTriggerBalanceAlerts("org-123", 0, "USD");
  assert.equal(outcome, "exhausted");
  assert.equal(walletUpdateCalled, true);
  assert.equal(emailCreated, true);
});

test("checkAndTriggerBalanceAlerts throttles within 24 hours cooldown", async (t) => {
  const { OrganizationModel } = await import("../src/models/Organization.js");
  const { CreditWalletModel } = await import("../src/models/CreditWallet.js");
  const { UserModel } = await import("../src/models/User.js");
  const { checkAndTriggerBalanceAlerts } = await import("../src/services/emailAutomationService.js");

  t.mock.method(OrganizationModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ ownerUserId: "user-123", whiteLabelAccountId: undefined }),
    }),
  }));

  t.mock.method(CreditWalletModel, "findOne", () => ({
    lean: async () => ({
      orgId: "org-123",
      balanceCredits: 0,
      exhaustedAlertSentAt: new Date(Date.now() - 60 * 1000), // sent 1 minute ago
    }),
  }));

  t.mock.method(UserModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ name: "Taylor", email: "taylor@example.com" }),
    }),
  }));

  const outcome = await checkAndTriggerBalanceAlerts("org-123", 0, "USD");
  assert.equal(outcome, "none");
});

test("checkAndTriggerBalanceAlerts triggers low balance alert when balance is $1.50", async (t) => {
  const { env } = await import("../src/config/env.js");
  const originalResendKey = env.resendApiKey;
  const originalEmailUser = env.emailUser;
  t.after(() => {
    env.resendApiKey = originalResendKey;
    env.emailUser = originalEmailUser;
  });
  env.resendApiKey = "";
  env.emailUser = "";

  const { OrganizationModel } = await import("../src/models/Organization.js");
  const { CreditWalletModel } = await import("../src/models/CreditWallet.js");
  const { UserModel } = await import("../src/models/User.js");
  const { EmailDeliveryModel } = await import("../src/models/EmailDelivery.js");
  const { checkAndTriggerBalanceAlerts } = await import("../src/services/emailAutomationService.js");

  t.mock.method(OrganizationModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ ownerUserId: "user-123", whiteLabelAccountId: undefined }),
    }),
  }));

  t.mock.method(CreditWalletModel, "findOne", () => ({
    lean: async () => ({ orgId: "org-123", balanceCredits: 1.5, lowBalanceAlertSentAt: undefined }),
  }));

  t.mock.method(UserModel, "findById", () => ({
    select: () => ({
      lean: async () => ({ name: "Taylor", email: "taylor@example.com" }),
    }),
  }));

  let walletUpdateCalled = false;
  t.mock.method(CreditWalletModel, "updateOne", async () => {
    walletUpdateCalled = true;
    return { modifiedCount: 1 };
  });

  let emailCreated = false;
  t.mock.method(EmailDeliveryModel, "create", async (input: { kind: string; to: string }) => {
    emailCreated = true;
    assert.equal(input.kind, "low-balance");
    assert.equal(input.to, "taylor@example.com");
    return { ...input, status: "preview" };
  });

  const outcome = await checkAndTriggerBalanceAlerts("org-123", 1.5, "USD");
  assert.equal(outcome, "low_balance");
  assert.equal(walletUpdateCalled, true);
  assert.equal(emailCreated, true);
});

