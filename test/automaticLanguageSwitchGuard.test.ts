import assert from "node:assert/strict";
import test from "node:test";

import {
  guardAutomaticLanguageSwitch,
  type AutomaticLanguageSwitchGuardState,
  type ReplyLanguageDetection,
} from "../src/services/languageSwitchingService.js";

const emptyState: AutomaticLanguageSwitchGuardState = {
  candidateLanguage: "",
  consecutiveCount: 0,
};
const hindiCandidate: ReplyLanguageDetection = {
  language: "Hindi",
  scriptStyle: "native",
  source: "stt-language",
};

test("keeps the current language after one ambiguous short detection", () => {
  const result = guardAutomaticLanguageSwitch({
    detection: hindiCandidate,
    text: "जी",
    currentLanguage: "English",
    currentScriptStyle: "roman",
    state: emptyState,
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.detection.language, "English");
  assert.deepEqual(result.state, { candidateLanguage: "Hindi", consecutiveCount: 1 });
});

test("accepts the second consecutive short detection without waiting", () => {
  const result = guardAutomaticLanguageSwitch({
    detection: hindiCandidate,
    text: "हाँ",
    currentLanguage: "English",
    currentScriptStyle: "roman",
    state: { candidateLanguage: "Hindi", consecutiveCount: 1 },
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.detection.language, "Hindi");
  assert.deepEqual(result.state, emptyState);
});

test("switches immediately for an explicit request", () => {
  const result = guardAutomaticLanguageSwitch({
    detection: { ...hindiCandidate, source: "explicit-request" },
    text: "Please switch to Hindi",
    currentLanguage: "English",
    currentScriptStyle: "roman",
    state: emptyState,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.detection.language, "Hindi");
});

test("switches immediately for a substantive final transcript", () => {
  const result = guardAutomaticLanguageSwitch({
    detection: hindiCandidate,
    text: "मुझे अपॉइंटमेंट चाहिए",
    currentLanguage: "English",
    currentScriptStyle: "roman",
    state: emptyState,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.detection.language, "Hindi");
});

test("resets an old candidate when the current language is detected", () => {
  const result = guardAutomaticLanguageSwitch({
    detection: {
      language: "English",
      scriptStyle: "roman",
      source: "stt-language",
    },
    text: "yes",
    currentLanguage: "English",
    currentScriptStyle: "roman",
    state: { candidateLanguage: "Hindi", consecutiveCount: 1 },
  });
  assert.equal(result.suppressed, false);
  assert.deepEqual(result.state, emptyState);
});
