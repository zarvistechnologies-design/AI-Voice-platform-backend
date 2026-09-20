import assert from "node:assert/strict";
import test from "node:test";

import { googleSheetCallRow, googleSheetCallRows } from "../src/services/integrationService.js";
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
