import assert from "node:assert/strict";
import test from "node:test";

import { resolveSttLanguagePolicy } from "../src/services/sttLanguagePolicy.js";

test("pins Hindi when multilingual support is enabled but switching is disabled", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "Hindi",
    supportedLanguages: ["Hindi", "English"],
    multilingualEnabled: true,
    languageSwitchingEnabled: false,
  }), {
    autoDetect: false,
    selectedLanguage: "Hindi",
  });
});

test("uses automatic STT detection only when multilingual switching is enabled", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "Hindi",
    supportedLanguages: ["Hindi", "English"],
    multilingualEnabled: true,
    languageSwitchingEnabled: true,
  }), {
    autoDetect: true,
    selectedLanguage: "Multilingual",
  });
});

test("does not auto-detect when only one effective language is configured", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "Hindi",
    supportedLanguages: ["Hindi"],
    multilingualEnabled: true,
    languageSwitchingEnabled: true,
  }), {
    autoDetect: false,
    selectedLanguage: "Hindi",
  });
});

test("pins the first supported language when the saved primary is Multilingual", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "Multilingual",
    supportedLanguages: ["Hindi", "English"],
    multilingualEnabled: true,
    languageSwitchingEnabled: false,
  }), {
    autoDetect: false,
    selectedLanguage: "Hindi",
  });
});

test("keeps ordinary single-language agents pinned", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "Tamil",
    supportedLanguages: ["Tamil", "English"],
    multilingualEnabled: false,
    languageSwitchingEnabled: false,
  }), {
    autoDetect: false,
    selectedLanguage: "Tamil",
  });
});

test("does not enable detection solely because a legacy primary language is blank", () => {
  assert.deepEqual(resolveSttLanguagePolicy({
    primaryLanguage: "",
    supportedLanguages: ["Hindi", "English"],
    multilingualEnabled: false,
    languageSwitchingEnabled: true,
  }), {
    autoDetect: false,
    selectedLanguage: "Hindi",
  });
});
