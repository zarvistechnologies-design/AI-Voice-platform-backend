import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";

const encryptedPrefix = "enc:v1:";

export function storeWhiteLabelResendKey(value: string) {
  const key = value.trim();
  return key ? `${encryptedPrefix}${encryptSecret(key)}` : "";
}

export function readWhiteLabelResendKey(value: string | undefined | null) {
  const stored = value?.trim() ?? "";
  if (!stored) return "";
  return stored.startsWith(encryptedPrefix)
    ? decryptSecret(stored.slice(encryptedPrefix.length))
    : stored; // Legacy plaintext remains readable until the migration or brand editor save.
}
