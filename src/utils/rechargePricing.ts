export const GST_RATE_BPS = 1800;
export const RECHARGE_GST_RATE_BPS = GST_RATE_BPS;

// Calculate tax in minor currency units so checkout and invoices round identically.
// `unitsPerCredit` lets the ledger remain in canonical USD credits while the
// customer is charged in the configured local currency.
export function rechargePricing(credits: number, unitsPerCredit = 1) {
  const subtotalMinor = Math.round(credits * unitsPerCredit * 100);
  const taxMinor = Math.round(subtotalMinor * RECHARGE_GST_RATE_BPS / 10_000);
  return {
    subtotalMinor,
    taxRateBps: RECHARGE_GST_RATE_BPS,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
  };
}
