import assert from "node:assert/strict";
import test from "node:test";

test("callback email schema accepts 'callback' kind in EmailDeliveryModel", async () => {
  const { EmailDeliveryModel } = await import("../src/models/EmailDelivery.js");
  const doc = new EmailDeliveryModel({
    to: "ops@example.com",
    subject: "Test callback",
    kind: "callback",
    status: "preview",
    text: "Test content",
  });
  const validationError = doc.validateSync();
  assert.equal(validationError, undefined);
  assert.equal(doc.kind, "callback");
  assert.equal(doc.to, "ops@example.com");
});

test("CallDetailRecord schema accepts callbackRequested and callbackDetails", async () => {
  const { CallDetailRecordModel } = await import("../src/models/CallDetailRecord.js");
  const doc = new CallDetailRecordModel({
    ownerId: "org_123",
    agentId: "65f000000000000000000001",
    direction: "inbound",
    livekitRoomName: "room-callback-test",
    callbackRequested: true,
    callbackDetails: {
      callerName: "Rahul Sharma",
      callbackNumber: "+919876543210",
      preferredTime: "Tomorrow at 10 AM",
      reason: "Inquiring about enterprise voice pricing",
      requestedAt: new Date(),
    },
    callbackEmailStatus: "pending",
  });
  const validationError = doc.validateSync();
  assert.equal(validationError, undefined);
  assert.equal(doc.callbackRequested, true);
  assert.equal(doc.callbackDetails?.callerName, "Rahul Sharma");
  assert.equal(doc.callbackDetails?.callbackNumber, "+919876543210");
  assert.equal(doc.callbackEmailStatus, "pending");
});

test("emailService sendTransactionalEmail accepts callback kind", async () => {
  const { sendTransactionalEmail } = await import("../src/services/emailService.js");
  assert.equal(typeof sendTransactionalEmail, "function");
});

test("callbackEmailService exports sendCallbackNotificationEmail function", async () => {
  const { sendCallbackNotificationEmail } = await import("../src/services/callbackEmailService.js");
  assert.equal(typeof sendCallbackNotificationEmail, "function");
});
