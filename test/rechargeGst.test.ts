import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { env } from "../src/config/env.js";
import { createRazorpayTopUp, downloadBillingInvoice, razorpayBillingTestHelpers } from "../src/controllers/razorpayBillingController.js";
import { BillingInvoiceModel } from "../src/models/BillingInvoice.js";
import { BillingTransactionModel } from "../src/models/BillingTransaction.js";
import { CreditWalletModel } from "../src/models/CreditWallet.js";
import { OrganizationModel } from "../src/models/Organization.js";

test("INR recharge charges GST, credits only the base once, and renders the invoice breakdown", async (t) => {
  const original = { whiteLabelEnabled: env.whiteLabelEnabled, razorpayKeyId: env.razorpayKeyId, razorpayKeySecret: env.razorpayKeySecret };
  t.after(() => Object.assign(env, original));
  Object.assign(env, { whiteLabelEnabled: false, razorpayKeyId: "rzp_test_gst", razorpayKeySecret: "test-secret" });

  let balance = 20;
  let ledger: Record<string, unknown> | undefined;
  let savedInvoice: Record<string, any> | undefined;
  let order: Record<string, any> | undefined;
  t.mock.method(CreditWalletModel, "findOneAndUpdate", async (_filter: unknown, update: Record<string, any>) => {
    balance += update.$inc?.balanceCredits ?? 0;
    return { balanceCredits: balance, lifetimePurchasedCredits: balance, currency: "USD" };
  });
  t.mock.method(mongoose.connection, "startSession", async () => ({
    withTransaction: async (callback: () => Promise<void>) => callback(),
    endSession: async () => undefined,
  }));
  t.mock.method(BillingTransactionModel, "findOne", () => ({ select: () => ({ session: async () => ledger }) }));
  t.mock.method(BillingTransactionModel, "create", async (documents: Record<string, unknown>[]) => {
    ledger = documents[0];
    return [ledger];
  });
  t.mock.method(BillingInvoiceModel, "findOneAndUpdate", async (_filter: unknown, update: Record<string, any>) => {
    savedInvoice ??= { ...update.$setOnInsert, ...update.$set, id: "invoice_gst", get: () => new Date("2026-09-13") };
    return savedInvoice;
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.razorpay.com/v1/orders");
    const body = JSON.parse(String(init.body));
    assert.equal(body.amount, 113870);
    assert.equal(body.currency, "INR");
    assert.equal(body.notes.credits, "10.000000");
    assert.equal(body.notes.billingCurrency, "INR");
    assert.equal(body.notes.taxMinor, "17370");
    order = { ...body, id: "order_gst", status: "paid", amount_paid: body.amount };
    return new Response(JSON.stringify(order), { status: 200 });
  });

  let checkout: Record<string, any> | undefined;
  const response = { status: (status: number) => { assert.equal(status, 201); return response; }, json: (value: Record<string, any>) => { checkout = value; } };
  await createRazorpayTopUp({ organization: { id: "org_test" }, body: { amountInr: 965, taxMinor: 0, amount: 1000 } } as never, response as never);
  assert.equal(checkout?.amount, 113870);
  assert.equal(checkout?.credits, 10);
  assert.equal(checkout?.currency, "INR");
  assert.equal(checkout?.subtotalMinor, 96500);
  assert.equal(checkout?.taxMinor, 17370);
  assert.equal(checkout?.taxRateBps, 1800);

  const payment = { id: "pay_gst", order_id: "order_gst", amount: 113870, currency: "INR", status: "captured" as const };
  await razorpayBillingTestHelpers.persistOrderPayment(order as never, payment);
  await razorpayBillingTestHelpers.persistOrderPayment(order as never, payment);
  assert.equal(balance, 30);
  assert.equal(ledger?.amountCredits, 10);
  assert.equal(savedInvoice?.amountPaid, 113870);
  assert.equal(savedInvoice?.subtotalMinor, 96500);
  assert.equal(savedInvoice?.taxMinor, 17370);
  assert.equal(savedInvoice?.taxRateBps, 1800);

  t.mock.method(BillingInvoiceModel, "findOne", async () => savedInvoice);
  t.mock.method(OrganizationModel, "findById", () => ({ select: async () => null }));
  let html = "";
  await downloadBillingInvoice({ organization: { id: "org_test" }, params: { invoiceId: "invoice_gst" } } as never, {
    setHeader: () => undefined, send: (value: string) => { html = value; },
  } as never);
  assert.match(html, /GST \(18%\)/);
  assert.match(html, /₹965\.00<\/strong>/);
  assert.match(html, /₹173\.70<\/strong>/);
  assert.match(html, /Total paid: ₹1,138\.70/);
});
