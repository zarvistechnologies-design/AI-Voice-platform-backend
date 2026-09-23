import assert from "node:assert/strict";
import test from "node:test";

import {
  googleSheetCallRecord,
  googleSheetCallRecords,
  googleSheetCallRow,
  googleSheetCallRows,
  googleSheetExportColumns,
  googleSheetLeadTemperature,
} from "../src/services/integrationService.js";
import { googleSpreadsheetId } from "../src/services/googleWorkspaceService.js";

test("Google Sheet links are stored as spreadsheet IDs", () => {
  assert.equal(
    googleSpreadsheetId("https://docs.google.com/spreadsheets/d/15hZsq0On1LvOv_BUNZ6vHv8V5_nttY-f78S_DECKSh4/edit#gid=0"),
    "15hZsq0On1LvOv_BUNZ6vHv8V5_nttY-f78S_DECKSh4",
  );
  assert.equal(
    googleSpreadsheetId("15hZsq0On1LvOv_BUNZ6vHv8V5_nttY-f78S_DECKSh4"),
    "15hZsq0On1LvOv_BUNZ6vHv8V5_nttY-f78S_DECKSh4",
  );
});

test("confirmed workflow results become a complete Google Sheets row", () => {
  const row = googleSheetCallRow(
    {
      _id: "call-123",
      status: "completed",
      callerNumber: "+919000000000",
      endedAt: new Date("2026-09-20T13:24:39.527Z"),
      structuredOutput: { outcome: "qualified" },
    },
    {
      kind: "site_visit",
      status: "confirmed",
      reference: "VZN-91515624",
      contactName: "Ananya",
      contactPhone: "+919876543210",
      summary: "The property site visit is confirmed in Vozon.",
      scheduledForText: "2026-09-27 10:00",
      createdAt: new Date("2026-09-20T13:21:52.804Z"),
      data: { property_name: "NDPS Heights", email: "ananya@example.com" },
    },
  );

  assert.deepEqual(row.slice(0, 5), [
    "2026-09-20T13:21:52.804Z",
    "Ananya",
    "+919876543210",
    "ananya@example.com",
    "confirmed",
  ]);
  assert.match(String(row[5]), /Type: Site Visit/);
  assert.match(String(row[5]), /Scheduled for: 2026-09-27 10:00/);
  assert.match(String(row[5]), /Reference: VZN-91515624/);
  assert.match(String(row[5]), /Property Name: NDPS Heights/);
  assert.equal(row[6], "call-123");
});

test("a completed call without a workflow still exports extracted outcomes", () => {
  const row = googleSheetCallRow({
    id: "call-456",
    status: "completed",
    callerNumber: "+919111111111",
    endedAt: "2026-09-20T14:00:00.000Z",
    structuredOutput: {
      caller_name: "Ravi",
      outcome: "follow_up",
      next_step: "Call tomorrow",
    },
  });

  assert.equal(row[1], "Ravi");
  assert.equal(row[2], "+919111111111");
  assert.equal(row[4], "follow_up");
  assert.match(String(row[5]), /Next Step: Call tomorrow/);
  assert.equal(row[6], "call-456");
});

test("outbound calls export the customer's number even without a workflow", () => {
  const row = googleSheetCallRow({
    id: "call-outbound",
    direction: "outbound",
    callerNumber: "+911234000000",
    calledNumber: "+919876543210",
    structuredOutput: { caller_name: "Ananya", outcome: "follow_up" },
  });

  assert.equal(row[2], "+919876543210");
});

test("outbound Google Sheet rows fall back to the imported campaign lead identity", () => {
  const records = googleSheetCallRecords(
    {
      id: "call-campaign-lead",
      direction: "outbound",
      status: "completed",
      campaignLead: {
        name: "Priya Sharma",
        phone: "+919812345678",
        email: "priya@example.com",
        customFields: { preferred_city: "Pune" },
      },
      structuredOutput: { outcome: "qualified" },
    },
    [],
    [],
  );

  assert.equal(records[0].caller_name, "Priya Sharma");
  assert.equal(records[0].phone, "+919812345678");
  assert.equal(records[0].email, "priya@example.com");
  assert.equal(records[0].preferred_city, "Pune");
});

test("common analysis name aliases populate Caller Name", () => {
  for (const [key, name] of [["lead_name", "Aarav"], ["full_name", "Meera"]]) {
    const records = googleSheetCallRecords({
      id: `call-${key}`,
      status: "completed",
      structuredOutput: { [key]: name },
    }, [], []);
    assert.equal(records[0].caller_name, name);
  }
});

test("Google Sheets classifies campaign leads as hot, warm, cold, or other", () => {
  assert.equal(googleSheetLeadTemperature({ campaignLead: { outcome: "qualified" } }), "Hot");
  assert.equal(googleSheetLeadTemperature({ campaignLead: { outcome: "follow_up" } }), "Warm");
  assert.equal(googleSheetLeadTemperature({ campaignLead: { outcome: "not_interested" } }), "Cold");
  assert.equal(googleSheetLeadTemperature({ campaignLead: { outcome: "missed" } }), "Other");
  assert.equal(googleSheetLeadTemperature({
    campaignLead: { outcome: "unknown", conversionStatus: "verified" },
  }), "Hot");
});

test("Google Sheets exports Lead Temperature as a stable core column", () => {
  const records = googleSheetCallRecords({
    id: "call-temperature",
    status: "completed",
    structuredOutput: { outcome: "follow_up" },
  }, [], []);
  const columns = googleSheetExportColumns([], records);

  assert.equal(records[0].lead_temperature, "Warm");
  assert.ok(columns.some((column) => column.key === "lead_temperature" && column.label === "Lead Temperature"));

  const booked = googleSheetCallRecords(
    { id: "call-booked", status: "completed" },
    [],
    [{ status: "booked", appointmentType: "Consultation" }],
  );
  assert.equal(booked[0].lead_temperature, "Hot");
});

test("every service outcome created during one call gets its own row", () => {
  const rows = googleSheetCallRows(
    { id: "call-789", status: "completed", endedAt: "2026-09-20T14:00:00.000Z" },
    [
      {
        kind: "qualified_property_lead",
        status: "qualified",
        createdAt: "2026-09-20T13:55:00.000Z",
        data: { location: "Noida", budget: "₹1 crore" },
      },
      {
        kind: "site_visit",
        status: "confirmed",
        createdAt: "2026-09-20T13:57:00.000Z",
        data: { property: "NDPS Heights", preferredDate: "2026-09-27" },
      },
    ],
    [],
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0][4], "qualified");
  assert.match(String(rows[0][5]), /Location: Noida/);
  assert.equal(rows[1][4], "confirmed");
  assert.match(String(rows[1][5]), /Property: NDPS Heights/);
});

test("structured exports merge every service from one call into one simple lead row", () => {
  const records = googleSheetCallRecords(
    {
      id: "call-real-estate",
      status: "completed",
      direction: "outbound",
      calledNumber: "+919876543210",
      endedAt: "2026-09-22T17:31:16.371Z",
      structuredOutput: {
        caller_name: "Varun",
        outcome: "qualified",
        next_step: "Arrange site visit",
        location: "Noida",
        budget: "INR 1 crore",
        visit_time: "2026-09-27 10:00",
      },
    },
    [
      {
        kind: "qualified_property_lead",
        status: "qualified",
        reference: "VZN-1233",
        data: { location: "Noida", propertyType: "3BHK", budget: "INR 1 crore" },
        createdAt: "2026-09-22T17:29:00.000Z",
      },
      {
        kind: "site_visit",
        status: "pending_confirmation",
        reference: "VZN-1234",
        scheduledForText: "2026-09-27 10:00",
        data: { property: "NDPS Heights", preferredDate: "2026-09-27" },
        createdAt: "2026-09-22T17:30:00.000Z",
      },
    ],
    [],
  );
  const columns = googleSheetExportColumns([
    { key: "outcome", label: "Outcome" },
    { key: "caller_name", label: "Caller Name" },
    { key: "next_step", label: "Next Step" },
    { key: "location", label: "Preferred Location" },
    { key: "budget", label: "Budget" },
    { key: "visit_time", label: "Visit Date/Time" },
  ], records);

  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "qualified");
  assert.equal(records[0].services, "Qualified Property Lead | Site Visit");
  assert.equal(records[0].service_status, "qualified | pending_confirmation");
  assert.equal(records[0].location, "Noida");
  assert.equal(records[0].property, "NDPS Heights");
  assert.match(String(records[0].details), /Qualified Property Lead:/);
  assert.match(String(records[0].details), /Site Visit:/);
  assert.match(String(records[0].details), /Property: NDPS Heights/);
  assert.deepEqual(
    columns.map((column) => column.label),
    [
      "Timestamp", "Caller Name", "Phone", "Email", "Outcome", "Lead Temperature", "Next Step",
      "Preferred Location", "Budget", "Visit Date/Time", "Services", "Status", "Details", "Call ID",
    ],
  );
});
