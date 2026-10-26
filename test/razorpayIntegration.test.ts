import assert from "node:assert/strict";
import test from "node:test";

import { readRazorpayPayments } from "../src/services/integrationService.js";

test("Razorpay credentials verify through a bounded read and return no caller data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.razorpay.com/v1/payments?count=1");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from("rzp_test_example:secret_example").toString("base64")}`,
    );
    return new Response(JSON.stringify({
      count: 1,
      items: [{
        id: "pay_example",
        amount: 4500,
        currency: "INR",
        status: "captured",
        created_at: 1700000000,
        email: "private@example.com",
        contact: "+919999999999",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await readRazorpayPayments(" rzp_test_example ", " secret_example ", 1);
    assert.deepEqual(result, {
      count: 1,
      payments: [{ id: "pay_example", amount: 4500, currency: "INR", status: "captured", createdAt: 1700000000 }],
    });
    assert.doesNotMatch(JSON.stringify(result), /private@example.com|9999999999/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Razorpay does not accept an invalid response as a verified connection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "unexpected" }), { status: 200 });
  try {
    await assert.rejects(readRazorpayPayments("key", "secret"), /invalid payments response/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
