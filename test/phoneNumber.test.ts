import assert from "node:assert/strict";
import test from "node:test";

import { normalizeE164 } from "../src/utils/phoneNumber.js";

test("keeps canonical international numbers", () => {
  assert.equal(normalizeE164("+12525550123"), "+12525550123");
  assert.equal(normalizeE164("+919876543210"), "+919876543210");
  assert.equal(normalizeE164("+971501234567"), "+971501234567");
});

test("normalizes pasted international display formats", () => {
  assert.equal(normalizeE164("+1 (252) 555-0123"), "+12525550123");
  assert.equal(normalizeE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164("00 971 50 123 4567"), "+971501234567");
});

test("rejects local, malformed, and extended numbers", () => {
  assert.equal(normalizeE164("9876543210"), "");
  assert.equal(normalizeE164("+01234567890"), "");
  assert.equal(normalizeE164("+1 252 555 0123 ext 9"), "");
  assert.equal(normalizeE164("+123"), "");
});
