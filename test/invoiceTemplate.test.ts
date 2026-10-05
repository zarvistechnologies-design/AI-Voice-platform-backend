import assert from "node:assert/strict";
import test from "node:test";

import { amountInWordsInr, renderTaxInvoiceHtml } from "../src/services/invoiceTemplate.js";
import { normalizeOptionalGstin } from "../src/utils/gstin.js";

const baseInvoice = {
  logoUrl: "https://www.vozon.ai/images/logo_2.svg",
  invoiceNumber: "VZN-00031",
  invoiceDate: new Date("2026-09-01T00:00:00.000Z"),
  status: "PAID",
  supplier: {
    name: "Zarvis Technologies Pvt. Ltd.",
    address: "Bengaluru, Karnataka - 560079",
    gstin: "29AABCZ0830H1ZC",
    email: "hello@vozon.ai",
    phone: "+91 78925 18414",
  },
  payTo: {
    accountName: "Zarvis Technologies Pvt. Ltd.",
    accountNumber: "001102000011580",
    bank: "Indian Overseas Bank",
    ifsc: "IOBA0000011",
    micr: "560020003",
    branch: "Gandhi Nagar, Bengaluru - 560009",
  },
  customer: { name: "Example Customer", email: "billing@example.com" },
  serviceDescription: "AI Voice Agent Software Service",
  sac: "998315",
  subtotalMinor: 380_000,
  taxRateBps: 1_800,
  taxMinor: 68_400,
  totalMinor: 448_400,
  currency: "INR",
  paymentProvider: "Razorpay",
  paymentId: "pay_example",
  orderId: "order_example",
};

test("GSTIN normalization accepts blank values and valid Indian GST numbers", () => {
  assert.equal(normalizeOptionalGstin(""), "");
  assert.equal(normalizeOptionalGstin(" 29aabcz0830h1zc "), "29AABCZ0830H1ZC");
  assert.throws(() => normalizeOptionalGstin("invalid"), /valid 15-character GSTIN/);
});

test("invoice renders the logo and only shows the optional customer GSTIN when supplied", () => {
  const withoutGstin = renderTaxInvoiceHtml(baseInvoice);
  assert.match(withoutGstin, /<img class="logo"/);
  assert.doesNotMatch(withoutGstin, /<h1>VOZON\.AI<\/h1>/);
  assert.equal((withoutGstin.match(/29AABCZ0830H1ZC/g) ?? []).length, 1);
  assert.doesNotMatch(withoutGstin, /<p class="billing-address">/);

  const withGstin = renderTaxInvoiceHtml({
    ...baseInvoice,
    customer: {
      ...baseInvoice.customer,
      gstin: "09AAACB2894G1ZJ",
      billingAddress: "42 Residency Road\nBengaluru, Karnataka 560025",
    },
  });
  assert.match(withGstin, /09AAACB2894G1ZJ/);
  assert.match(withGstin, /42 Residency Road\nBengaluru, Karnataka 560025/);
  assert.match(withGstin, /class="billing-address"/);
  assert.match(withGstin, /HSN\/SAC/);
  assert.match(withGstin, /GST \(18%\)/);
  assert.match(withGstin, /--brand:#0d776e/);
  assert.match(withGstin, /--brand-soft:#eaf7f5/);
  assert.match(withGstin, /Indian Overseas Bank/);
  assert.match(withGstin, /Authorised Signatory/);
  assert.match(withGstin, /Thank you for choosing Vozon\.ai/);
});

test("INR amount is written using Indian number groups", () => {
  assert.equal(amountInWordsInr(448_400), "Four Thousand Four Hundred Eighty Four Rupees Only");
  assert.equal(amountInWordsInr(1_00_00_001), "One Lakh Rupees And One Paise Only");
});
