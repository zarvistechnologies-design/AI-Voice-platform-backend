import assert from "node:assert/strict";
import test from "node:test";
import { dedupeLegacyUserTranscriptItems } from "../src/services/transcriptDeduplication.js";

const provisional = {
  itemId: "user-final-1000-example",
  role: "user",
  text: "मुझे अपॉइंटमेंट चाहिए था।",
  timestamp: "2026-08-27T05:28:33.000Z",
};

const canonical = {
  ...provisional,
  itemId: "livekit-message-id",
  timestamp: "2026-08-27T05:28:33.250Z",
};

test("collapses the legacy STT and canonical transcript pair", () => {
  assert.deepEqual(
    dedupeLegacyUserTranscriptItems([provisional, canonical]),
    [canonical],
  );
  assert.deepEqual(
    dedupeLegacyUserTranscriptItems([canonical, provisional]),
    [canonical],
  );
});

test("preserves a genuine repeated user message at a later time", () => {
  const later = {
    ...canonical,
    itemId: "later-livekit-message-id",
    timestamp: "2026-08-27T05:28:40.000Z",
  };

  assert.deepEqual(
    dedupeLegacyUserTranscriptItems([canonical, later]),
    [canonical, later],
  );
});

test("does not collapse two canonical user messages", () => {
  const repeated = {
    ...canonical,
    itemId: "another-livekit-message-id",
    timestamp: "2026-08-27T05:28:33.500Z",
  };

  assert.deepEqual(
    dedupeLegacyUserTranscriptItems([canonical, repeated]),
    [canonical, repeated],
  );
});
