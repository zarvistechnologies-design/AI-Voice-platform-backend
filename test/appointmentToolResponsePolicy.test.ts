import assert from "node:assert/strict";
import test from "node:test";

import {
  appointmentToolFailureMessage,
  hasAppointmentAvailabilityData,
  hasAppointmentBookingSuccess,
  parseAppointmentToolResponse,
} from "../src/services/appointmentToolResponsePolicy.js";

test("accepts the Swastik booking response contract", () => {
  const response = parseAppointmentToolResponse(JSON.stringify({
    booked: true,
    appointmentId: "visit-123",
  }));

  assert.equal(hasAppointmentBookingSuccess(response), true);
  assert.equal(appointmentToolFailureMessage(response), "");
});

test("preserves a not-booked response as a booking failure", () => {
  const response = parseAppointmentToolResponse(JSON.stringify({
    booked: false,
    message: "NOT BOOKED: choose another time",
  }));

  assert.equal(hasAppointmentBookingSuccess(response), false);
  assert.equal(appointmentToolFailureMessage(response), "NOT BOOKED: choose another time");
});

test("accepts generic showroom availability response shapes, including no free slots", () => {
  assert.equal(hasAppointmentAvailabilityData({ available: true, freeTimes: ["3:00 PM"] }), true);
  assert.equal(hasAppointmentAvailabilityData({ available: false, freeTimes: [] }), true);
  assert.equal(hasAppointmentAvailabilityData({ free_times: ["4:30 PM"] }), true);
});
