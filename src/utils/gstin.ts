import { HttpError } from "./httpError.js";

// GSTIN: state code + PAN + entity number + Z + checksum character.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeOptionalGstin(value: unknown) {
  const gstin = typeof value === "string" ? value.trim().replace(/\s+/g, "").toUpperCase() : "";
  if (!gstin) return "";
  if (!GSTIN_PATTERN.test(gstin)) {
    throw new HttpError(400, "Enter a valid 15-character GSTIN, or leave it blank.");
  }
  return gstin;
}

export function isValidGstin(value: unknown): value is string {
  return typeof value === "string" && GSTIN_PATTERN.test(value.trim().toUpperCase());
}
