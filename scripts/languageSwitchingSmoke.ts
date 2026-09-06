import assert from "node:assert/strict";

import {
  detectReplyLanguage,
  finalTranscriptMatchesTurn,
  languageFromProviderCode,
  strictAutomaticLanguageSwitchingError,
  supportsStrictAutomaticLanguageSwitching,
  transcriptsMatch,
  type LanguageOption,
} from "../src/services/languageSwitchingService.js";

const catalog: LanguageOption[] = [
  { value: "English", label: "English (India)", code: "en-IN" },
  { value: "English UK", label: "English (UK)", code: "en-GB" },
  { value: "Hindi", label: "Hindi", code: "hi-IN" },
  { value: "Marathi", label: "Marathi", code: "mr-IN" },
  { value: "Tamil", label: "Tamil", code: "ta-IN" },
  { value: "French", label: "French", code: "fr-FR" },
  { value: "Portuguese Portugal", label: "Portuguese (Portugal)", code: "pt-PT" },
  { value: "Arabic", label: "Arabic", code: "ar-SA" },
  { value: "Chinese Mandarin", label: "Chinese (Mandarin)", code: "zh-CN" },
];

function detect(input: Partial<Parameters<typeof detectReplyLanguage>[0]> & { text: string }) {
  return detectReplyLanguage({
    allowedLanguages: ["English", "Hindi"],
    catalog,
    previousLanguage: "English",
    previousScriptStyle: "roman",
    ...input,
  });
}

// Provider audio-language metadata is stronger than an ambiguous shared word.
assert.deepEqual(detect({ text: "doctor", providerLanguageCode: "hi-IN" }), {
  language: "Hindi",
  scriptStyle: "roman",
  source: "stt-language",
});
assert.equal(detect({
  text: "appointment",
  providerLanguageCode: "en",
  previousLanguage: "Hindi",
  previousScriptStyle: "native",
})?.language, "English");

// Without provider evidence, a lone Latin word keeps conversation state.
assert.deepEqual(detect({
  text: "doctor!",
  previousLanguage: "Hindi",
  previousScriptStyle: "native",
}), {
  language: "Hindi",
  scriptStyle: "native",
  source: "current-language",
});

// Explicit requests win even when a provider reports the utterance language.
assert.equal(detect({
  text: "Please switch to Hindi",
  providerLanguageCode: "en-IN",
})?.source, "explicit-request");
assert.equal(detect({
  text: "Please switch to Hindi",
  providerLanguageCode: "en-IN",
})?.language, "Hindi");

// Target-language matching is generated for every configured language.
assert.equal(detectReplyLanguage({
  text: "Please respond in French",
  allowedLanguages: ["English", "French"],
  catalog,
  previousLanguage: "English",
})?.language, "French");

// A caller answering the opening language menu with only the language name
// must switch the next response even when STT labels that English word as en.
assert.deepEqual(detectReplyLanguage({
  text: "Arabic",
  allowedLanguages: ["English", "Arabic"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
}), {
  language: "Arabic",
  scriptStyle: "native",
  source: "explicit-request",
});
assert.equal(detectReplyLanguage({
  text: "Portuguese, please.",
  allowedLanguages: ["English", "Portuguese Portugal"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
})?.language, "Portuguese Portugal");
assert.equal(detectReplyLanguage({
  text: "Mandarin",
  allowedLanguages: ["English", "Chinese Mandarin"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
})?.language, "Chinese Mandarin");
assert.equal(detectReplyLanguage({
  text: "العربية",
  allowedLanguages: ["English", "Arabic"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
})?.language, "Arabic");
assert.equal(detectReplyLanguage({
  text: "Português",
  allowedLanguages: ["English", "Portuguese Portugal"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
})?.language, "Portuguese Portugal");
assert.equal(detectReplyLanguage({
  text: "普通话",
  allowedLanguages: ["English", "Chinese Mandarin"],
  catalog,
  providerLanguageCode: "en",
  previousLanguage: "English",
})?.language, "Chinese Mandarin");

// Script and word-list guessing are deliberately disabled. Without provider
// evidence, even native-script and Romanized turns keep the current language.
assert.deepEqual(detect({ text: "\u092e\u0941\u091d\u0947 \u0938\u0939\u093e\u092f\u0924\u093e \u091a\u093e\u0939\u093f\u090f" }), {
  language: "English",
  scriptStyle: "roman",
  source: "current-language",
});
assert.deepEqual(detect({ text: "aap kaise hai" }), {
  language: "English",
  scriptStyle: "roman",
  source: "current-language",
});
assert.deepEqual(detectReplyLanguage({
  text: "\u0b8e\u0ba9\u0b95\u0bcd\u0b95\u0bc1 \u0b89\u0ba4\u0bb5\u0bbf \u0bb5\u0bc7\u0ba3\u0bcd\u0b9f\u0bc1\u0bae\u0bcd",
  allowedLanguages: ["English", "Tamil"],
  catalog,
  providerLanguageCode: "ta-IN",
  previousLanguage: "English",
}), {
  language: "Tamil",
  scriptStyle: "native",
  source: "stt-language",
});

// Same-script pairs fall back to the provider instead of guessing by glyphs.
assert.equal(detectReplyLanguage({
  text: "\u092e\u0932\u093e \u092e\u0926\u0924 \u092a\u093e\u0939\u093f\u091c\u0947",
  allowedLanguages: ["Hindi", "Marathi"],
  catalog,
  providerLanguageCode: "mr",
  previousLanguage: "Hindi",
})?.language, "Marathi");

// Base BCP-47 codes are resolved against the allowed set; an active regional
// variant is retained when a provider only returns an ambiguous base code.
assert.equal(languageFromProviderCode("HI_in", ["English", "Hindi"], catalog), "Hindi");
assert.equal(
  languageFromProviderCode("en", ["English", "English UK"], catalog, "English UK"),
  "English UK",
);
assert.equal(languageFromProviderCode("fr", ["English", "Hindi"], catalog), undefined);
assert.equal(languageFromProviderCode("ara", ["English", "Arabic"], catalog), "Arabic");
assert.equal(
  languageFromProviderCode("por", ["English", "Portuguese Portugal"], catalog),
  "Portuguese Portugal",
);
assert.equal(
  languageFromProviderCode("zho", ["English", "Chinese Mandarin"], catalog),
  "Chinese Mandarin",
);
assert.equal(
  languageFromProviderCode("cmn", ["English", "Chinese Mandarin"], catalog),
  "Chinese Mandarin",
);

// Unknown, missing, or disallowed provider codes never trigger a guess.
assert.deepEqual(detect({ text: "bonjour", providerLanguageCode: "fr" }), {
  language: "English",
  scriptStyle: "roman",
  source: "current-language",
});
assert.equal(detect({ text: "doctor", providerLanguageCode: "unknown" })?.language, "English");

// Strict switching is available only where the runtime has authoritative
// evidence or where a native realtime model handles audio directly.
assert.equal(supportsStrictAutomaticLanguageSwitching({ pipelineMode: "realtime", sttProvider: "openai" }), true);
assert.equal(supportsStrictAutomaticLanguageSwitching({ pipelineMode: "pipeline", sttProvider: "sarvam" }), true);
assert.equal(supportsStrictAutomaticLanguageSwitching({ pipelineMode: "pipeline", sttProvider: "deepgram" }), true);
assert.equal(supportsStrictAutomaticLanguageSwitching({ pipelineMode: "pipeline", sttProvider: "openai" }), false);
assert.equal(supportsStrictAutomaticLanguageSwitching({ pipelineMode: "pipeline", sttProvider: "elevenlabs" }), true);
assert.match(
  strictAutomaticLanguageSwitchingError({ pipelineMode: "pipeline", sttProvider: "openai" }),
  /Sarvam, Deepgram, or ElevenLabs Scribe v2 Realtime/,
);
assert.equal(
  strictAutomaticLanguageSwitchingError({ pipelineMode: "pipeline", sttProvider: "sarvam" }),
  "",
);

assert.equal(transcriptsMatch(" Doctor? ", "doctor."), true);
assert.equal(transcriptsMatch("\u0939\u093e\u0901\u0964", "\u0939\u093e\u0901"), true);
assert.equal(finalTranscriptMatchesTurn("need help", "I need help."), true);
assert.equal(finalTranscriptMatchesTurn("help", "help me"), false);

console.log("Language switching smoke tests passed.");
