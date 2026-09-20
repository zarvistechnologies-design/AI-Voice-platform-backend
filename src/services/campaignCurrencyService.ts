import { env } from "../config/env.js";

/**
 * Campaign reporting uses INR as its single presentation currency. Legacy call
 * records and business events were stored in USD, so missing/non-INR currency
 * codes are treated as USD and converted with the configured billing rate.
 */
export function campaignAmountInr(
  value: unknown,
  currency: unknown,
  inrPerUsd = env.costRates.inrPerUsd,
) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return String(currency ?? "USD").trim().toUpperCase() === "INR"
    ? amount
    : amount * inrPerUsd;
}
