export type SttLanguagePolicyInput = {
  primaryLanguage: string;
  supportedLanguages: readonly string[];
  multilingualEnabled: boolean;
  languageSwitchingEnabled: boolean;
};

export type SttLanguagePolicy = {
  autoDetect: boolean;
  selectedLanguage: string;
};

function usableLanguage(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.toLowerCase() !== "multilingual" ? normalized : "";
}

/**
 * Multilingual support and automatic language detection are separate choices.
 * Keep STT pinned to the primary language unless per-turn switching is enabled;
 * otherwise short Hindi/Hinglish phrases can be misclassified by providers.
 */
export function resolveSttLanguagePolicy(input: SttLanguagePolicyInput): SttLanguagePolicy {
  const primaryIsMultilingual = input.primaryLanguage.trim().toLowerCase() === "multilingual";
  const configuredPrimary = usableLanguage(input.primaryLanguage);
  const supported = input.supportedLanguages
    .map((language) => usableLanguage(language))
    .filter(Boolean);
  const supportedPrimary = supported[0] ?? "";
  const selectedLanguage = configuredPrimary || supportedPrimary || "English";
  const multilingualMode = input.multilingualEnabled || primaryIsMultilingual;
  const availableLanguages = new Set(
    [configuredPrimary, ...supported]
      .filter(Boolean)
      .map((language) => language.toLowerCase()),
  );
  const autoDetect = multilingualMode
    && input.languageSwitchingEnabled
    && availableLanguages.size > 1;

  return {
    autoDetect,
    selectedLanguage: autoDetect ? "Multilingual" : selectedLanguage,
  };
}
