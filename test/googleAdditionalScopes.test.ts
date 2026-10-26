import assert from "node:assert/strict";
import test from "node:test";

import { googleAuthorizationUrl } from "../src/services/googleWorkspaceService.js";

function scopes(feature: "core" | "drive" | "docs" | "gmail") {
  const url = new URL(googleAuthorizationUrl("workspace-test", feature));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  return new Set((url.searchParams.get("scope") ?? "").split(" "));
}

test("Google asks for each additional permission only when that card is connected", () => {
  const core = scopes("core");
  assert.ok(core.has("https://www.googleapis.com/auth/calendar"));
  assert.ok(core.has("https://www.googleapis.com/auth/spreadsheets"));
  assert.ok(!core.has("https://www.googleapis.com/auth/gmail.readonly"));

  const drive = scopes("drive");
  assert.ok(drive.has("https://www.googleapis.com/auth/drive.readonly"));
  assert.ok(!drive.has("https://www.googleapis.com/auth/gmail.readonly"));

  const docs = scopes("docs");
  assert.ok(docs.has("https://www.googleapis.com/auth/drive.metadata.readonly"));
  assert.ok(docs.has("https://www.googleapis.com/auth/documents.readonly"));

  const gmail = scopes("gmail");
  assert.ok(gmail.has("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(!gmail.has("https://www.googleapis.com/auth/drive.readonly"));
});
