import assert from "node:assert/strict";
import test from "node:test";

import { voiceLanguages } from "../src/services/modelCatalog.js";

const documentLanguages = [
  "English",
  "Vietnamese",
  "Khmer",
  "Lao",
  "Burmese",
  "Indonesian",
  "Malay",
  "Cantonese",
  "Chinese Mandarin",
  "Portuguese Portugal",
  "Mongolian",
  "Arabic",
  "Kurdish",
  "Russian",
  "Kazakh",
  "Uzbek",
  "Kyrgyz",
  "Georgian",
  "Tajik",
  "Turkmen",
  "Armenian",
  "French",
  "Swahili",
  "Spanish",
  "Dutch",
  "Guarani",
  "Quechua",
  "Aymara",
  "Sranan Tongo",
] as const;

test("voice catalog includes every concrete language named in the calling table", () => {
  const values = new Set(voiceLanguages.map((language) => language.value));
  const missing = documentLanguages.filter((language) => !values.has(language));
  assert.deepEqual(missing, []);
});

test("voice catalog language values and locale codes are unique", () => {
  const values = voiceLanguages.map((language) => language.value);
  const codes = voiceLanguages.map((language) => language.code);
  assert.equal(new Set(values).size, values.length);
  assert.equal(new Set(codes).size, codes.length);
});
