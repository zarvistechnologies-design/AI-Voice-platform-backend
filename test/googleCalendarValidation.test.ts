import assert from "node:assert/strict";
import test from "node:test";

import { googleCalendarWindow } from "../src/services/googleWorkspaceService.js";

test("Google Calendar normalizes valid offset date-times", () => {
  const window = googleCalendarWindow(
    "2099-01-15T10:00:00+05:30",
    "2099-01-15T10:30:00+05:30",
  );
  assert.equal(window.start, "2099-01-15T04:30:00.000Z");
  assert.equal(window.end, "2099-01-15T05:00:00.000Z");
});

test("Google Calendar rejects times without an explicit timezone", () => {
  assert.throws(
    () => googleCalendarWindow("2099-01-15T10:00:00", "2099-01-15T10:30:00"),
    /timezone offset/,
  );
});

test("Google Calendar rejects reversed and excessively long appointments", () => {
  assert.throws(
    () => googleCalendarWindow("2099-01-15T10:30:00Z", "2099-01-15T10:00:00Z"),
    /after its start time/,
  );
  assert.throws(
    () => googleCalendarWindow("2099-01-15T10:00:00Z", "2099-01-17T10:00:00Z"),
    /longer than 24 hours/,
  );
});

test("Google Calendar rejects past bookings", () => {
  assert.throws(
    () => googleCalendarWindow("2020-01-15T10:00:00Z", "2020-01-15T10:30:00Z", { requireFuture: true }),
    /future time/,
  );
});
