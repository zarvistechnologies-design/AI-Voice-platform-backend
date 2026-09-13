import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../src/config/env.js";
import { CreditWalletModel } from "../src/models/CreditWallet.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { WhiteLabelSubscriptionModel } from "../src/models/WhiteLabelSubscription.js";
import { creditBillingSettings, ensureCreditWallet } from "../src/services/billingService.js";

test("a direct user's new wallet receives exactly $1 without backfilling an existing empty wallet", async (t) => {
  const originalWhiteLabelEnabled = env.whiteLabelEnabled;
  t.after(() => { env.whiteLabelEnabled = originalWhiteLabelEnabled; });
  env.whiteLabelEnabled = false;
  assert.equal(creditBillingSettings.initialCredits, 1);

  let writes = 0;
  t.mock.method(CreditWalletModel, "findOneAndUpdate", async (_filter: unknown, update: Record<string, any>) => {
    writes += 1;
    assert.equal(update.$setOnInsert.balanceCredits, 1);
    assert.equal(update.$setOnInsert.lifetimePurchasedCredits, 1);
    return { balanceCredits: 0, lifetimePurchasedCredits: 0, currency: "USD" };
  });

  const wallet = await ensureCreditWallet("direct-org");
  assert.equal(writes, 1);
  assert.equal(wallet.balanceCredits, 0);
});

test("a white-label user's new wallet still starts at zero", async (t) => {
  const originalWhiteLabelEnabled = env.whiteLabelEnabled;
  t.after(() => { env.whiteLabelEnabled = originalWhiteLabelEnabled; });
  env.whiteLabelEnabled = true;

  t.mock.method(OrganizationModel, "findById", () => ({
    select: () => ({ lean: async () => ({ whiteLabelAccountId: "account-1" }) }),
  }));
  t.mock.method(WhiteLabelSubscriptionModel, "findOne", () => ({
    select: () => ({ lean: async () => ({ priceSnapshot: { currency: "INR" } }) }),
  }));
  t.mock.method(CreditWalletModel, "findOneAndUpdate", async (_filter: unknown, update: Record<string, any>) => {
    assert.equal(update.$setOnInsert.balanceCredits, 0);
    assert.equal(update.$setOnInsert.lifetimePurchasedCredits, 0);
    assert.equal(update.$setOnInsert.currency, "INR");
    return { balanceCredits: 0, lifetimePurchasedCredits: 0, currency: "INR" };
  });

  const wallet = await ensureCreditWallet("white-label-org");
  assert.equal(wallet.balanceCredits, 0);
});
