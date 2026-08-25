export type LanguageOption = {
  value: string;
  label: string;
  code: string;
};

export type ReplyScriptStyle = "native" | "roman";

export type ReplyLanguageDetectionSource =
  | "explicit-request"
  | "stt-language"
  | "current-language";

export type ReplyLanguageDetection = {
  language: string;
  scriptStyle: ReplyScriptStyle;
  source: ReplyLanguageDetectionSource;
};

const nativeScriptLanguageCodes = new Set([
  "ar", "as", "be", "bg", "bn", "brx", "doi", "el", "fa", "gu", "he", "hi",
  "ja", "km", "kn", "ko", "kok", "ks", "lo", "mai", "mk", "ml", "mni", "mr",
  "my", "ne", "od", "or", "pa", "ps", "ru", "sa", "sat", "sd", "si", "sr",
  "ta", "te", "th", "uk", "ur", "yi", "zh",
]);
const unknownLanguageCodes = new Set(["", "unknown", "und", "multi", "multilingual"]);
const strictPipelineSttProviders = new Set(["sarvam", "deepgram", "elevenlabs"]);
const providerLanguageCodeAliases: Record<string, string> = {
  ara: "ar",
  cmn: "zh",
  eng: "en",
  por: "pt",
  zho: "zh",
};
const spokenLanguageAliases: Record<string, readonly string[]> = {
  ar: ["arabic", "العربية", "عربي"],
  en: ["english"],
  pt: ["portuguese", "português", "portugues"],
  zh: ["mandarin", "mandarin chinese", "chinese mandarin", "chinese", "普通话", "中文", "國語", "国语"],
};

export function supportsStrictAutomaticLanguageSwitching(input: {
  pipelineMode: string;
  sttProvider: string;
}) {
  return input.pipelineMode === "realtime" || (
    input.pipelineMode === "pipeline" && strictPipelineSttProviders.has(input.sttProvider)
  );
}

export function strictAutomaticLanguageSwitchingError(input: {
  pipelineMode: string;
  sttProvider: string;
}) {
  return supportsStrictAutomaticLanguageSwitching(input)
    ? ""
    : "Strict automatic language switching in pipeline mode requires Sarvam, Deepgram, or ElevenLabs Scribe v2 Realtime speech recognition. OpenAI pipeline STT does not guarantee an authoritative per-turn language code.";
}

function normalizedLanguage(value: string) {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function baseLanguageCode(value: string) {
  return normalizedLanguage(value).split("-")[0] ?? "";
}

function normalizedProviderLanguageCode(value: string) {
  const normalized = normalizedLanguage(value);
  const [base, ...remainder] = normalized.split("-");
  const resolvedBase = providerLanguageCodeAliases[base] ?? base;
  return [resolvedBase, ...remainder].filter(Boolean).join("-");
}

function languageMatchesValue(language: LanguageOption, value: string) {
  const normalized = normalizedLanguage(value);
  return [language.value, language.label, language.code]
    .some((candidate) => normalizedLanguage(candidate) === normalized);
}

function languageForValue(value: string, catalog: readonly LanguageOption[]) {
  return catalog.find((language) => languageMatchesValue(language, value));
}

function allowedDefinitions(
  allowedLanguages: readonly string[],
  catalog: readonly LanguageOption[],
) {
  const definitions = allowedLanguages.map((allowed) => languageForValue(allowed, catalog) ?? {
    value: allowed.trim(),
    label: allowed.trim(),
    code: "",
  });
  return definitions.filter((language, index) =>
    language.value && definitions.findIndex((candidate) => candidate.value === language.value) === index,
  );
}

export function canonicalReplyLanguage(value: string, catalog: readonly LanguageOption[]) {
  return languageForValue(value, catalog)?.value ?? value.trim();
}

export function normalizeTranscript(value: string) {
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .join(" ");
}

export function transcriptsMatch(left: string, right: string) {
  const normalizedLeft = normalizeTranscript(left);
  return Boolean(normalizedLeft) && normalizedLeft === normalizeTranscript(right);
}

export function finalTranscriptMatchesTurn(finalTranscript: string, turnTranscript: string) {
  const normalizedFinal = normalizeTranscript(finalTranscript);
  const normalizedTurn = normalizeTranscript(turnTranscript);
  return Boolean(normalizedFinal) && (
    normalizedFinal === normalizedTurn || normalizedTurn.endsWith(` ${normalizedFinal}`)
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitLanguageRequest(
  text: string,
  allowedLanguages: readonly string[],
  catalog: readonly LanguageOption[],
) {
  const normalizedText = normalizeTranscript(text);
  for (const language of allowedDefinitions(allowedLanguages, catalog)) {
    const targets = [...new Set([
      language.value,
      language.label.replace(/\s*\([^)]*\)\s*$/, ""),
      ...(spokenLanguageAliases[baseLanguageCode(language.code)] ?? []),
    ].map((value) => value.trim()).filter((value) => value.length >= 3))];
    for (const target of targets) {
      const escapedTarget = escapeRegExp(target);
      const patterns = [
        new RegExp(`\\b(?:speak|talk|reply|respond|continue|switch|change|use)\\s*(?:(?:to|in|into)\\s+)?(?:the\\s+)?${escapedTarget}(?:\\s+language)?\\b`, "iu"),
        new RegExp(`\\b${escapedTarget}\\s+(?:please|language)\\b`, "iu"),
        new RegExp(`^(?:please\\s+)?(?:the\\s+)?${escapedTarget}(?:\\s+language)?(?:\\s+please)?$`, "iu"),
      ];
      if (patterns.some((pattern) => pattern.test(normalizedText))) return language;
    }
  }
  return undefined;
}

function scriptStyleForText(text: string, fallback: ReplyScriptStyle): ReplyScriptStyle {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return fallback;
  return letters.some((character) => !/\p{Script=Latin}/u.test(character)) ? "native" : "roman";
}

export function defaultReplyScriptStyle(
  languageValue: string,
  catalog: readonly LanguageOption[],
): ReplyScriptStyle {
  const language = languageForValue(languageValue, catalog);
  return language && nativeScriptLanguageCodes.has(baseLanguageCode(language.code)) ? "native" : "roman";
}

export function languageFromProviderCode(
  providerLanguageCode: string,
  allowedLanguages: readonly string[],
  catalog: readonly LanguageOption[],
  previousLanguage = "",
) {
  const rawProviderCode = normalizedLanguage(providerLanguageCode);
  if (unknownLanguageCodes.has(rawProviderCode)) return undefined;
  const providerCode = normalizedProviderLanguageCode(rawProviderCode);
  const allowed = allowedDefinitions(allowedLanguages, catalog);
  const exact = allowed.find((language) => languageMatchesValue(language, providerCode));
  if (exact) return exact.value;

  const providerBase = baseLanguageCode(providerCode);
  const baseMatches = allowed.filter((language) =>
    language.code && baseLanguageCode(language.code) === providerBase,
  );
  if (baseMatches.length === 1) return baseMatches[0].value;
  if (baseMatches.length > 1) {
    const previous = canonicalReplyLanguage(previousLanguage, catalog);
    return baseMatches.find((language) => language.value === previous)?.value ?? baseMatches[0].value;
  }
  return undefined;
}

export function detectReplyLanguage(input: {
  text: string;
  allowedLanguages: readonly string[];
  catalog: readonly LanguageOption[];
  providerLanguageCode?: string;
  previousLanguage?: string;
  previousScriptStyle?: ReplyScriptStyle;
}): ReplyLanguageDetection | null {
  const allowedLanguages = allowedDefinitions(input.allowedLanguages, input.catalog)
    .map((language) => language.value);
  if (!allowedLanguages.length) return null;

  const explicit = explicitLanguageRequest(input.text, allowedLanguages, input.catalog);
  if (explicit) {
    return {
      language: explicit.value,
      scriptStyle: defaultReplyScriptStyle(explicit.value, input.catalog),
      source: "explicit-request",
    };
  }

  const providerLanguage = input.providerLanguageCode
    ? languageFromProviderCode(
        input.providerLanguageCode,
        allowedLanguages,
        input.catalog,
        input.previousLanguage,
      )
    : undefined;
  if (providerLanguage) {
    return {
      language: providerLanguage,
      scriptStyle: scriptStyleForText(
        input.text,
        defaultReplyScriptStyle(providerLanguage, input.catalog),
      ),
      source: "stt-language",
    };
  }

  const currentLanguage = canonicalReplyLanguage(
    input.previousLanguage || allowedLanguages[0],
    input.catalog,
  );
  if (allowedLanguages.includes(currentLanguage)) {
    return {
      language: currentLanguage,
      scriptStyle:
        input.previousScriptStyle ?? defaultReplyScriptStyle(currentLanguage, input.catalog),
      source: "current-language",
    };
  }

  return null;
}
