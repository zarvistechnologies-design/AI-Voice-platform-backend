export const e164Pattern = /^\+[1-9]\d{7,14}$/;

/**
 * Converts common international display/dialing formats to canonical E.164.
 * A country code is always required; local numbers are deliberately not
 * guessed because the organization or caller can be in any country.
 */
export function normalizeE164(value: unknown) {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (!input) return "";

  const internationalPrefix = input.startsWith("+")
    ? "+"
    : input.startsWith("00")
      ? "00"
      : "";
  if (!internationalPrefix) return "";

  const body = input.slice(internationalPrefix.length).trim();
  // Accept formatting characters people commonly paste from address books,
  // while rejecting extensions, letters, and ambiguous punctuation.
  if (!/^[\d\s().-]+$/.test(body)) return "";

  const normalized = `+${body.replace(/\D/g, "")}`;
  return e164Pattern.test(normalized) ? normalized : "";
}
