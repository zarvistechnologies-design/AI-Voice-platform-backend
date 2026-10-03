export function walletCurrency(value: unknown): "INR" | "USD" {
  return String(value ?? "").toUpperCase() === "INR" ? "INR" : "USD";
}

export function usdToWalletRate(currency: unknown, inrPerUsd: number) {
  return walletCurrency(currency) === "INR" ? inrPerUsd : 1;
}

export function callBillingCurrency(input: {
  settled: boolean;
  transactionCurrency?: string;
  costCurrency?: string;
  fallbackCurrency?: string;
}) {
  return walletCurrency(
    input.settled
      ? input.transactionCurrency ?? input.fallbackCurrency
      : input.costCurrency ?? input.fallbackCurrency,
  );
}
