import assert from "node:assert/strict";
import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { BillingTransactionModel } from "../src/models/BillingTransaction.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { MODEL_PRICING_VERSION } from "../src/services/modelPricingService.js";

const EPSILON = 0.000002;
const close = (left: number, right: number) => Math.abs(left - right) <= EPSILON;
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

await connectDatabase({ autoIndex: false });

try {
  const calls = await CallDetailRecordModel.find({
    status: { $in: ["completed", "failed", "cancelled"] },
  })
    .select("+billingUsageRevision")
    .lean();
  const callIds = calls.map((call) => String(call._id));
  const ledger = await BillingTransactionModel.find({
    category: "call",
    callId: { $in: callIds },
    type: { $in: ["deduction", "refund"] },
  })
    .select("+deductionKey")
    .lean();

  const ledgerByCall = new Map<string, typeof ledger>();
  for (const row of ledger) {
    const rows = ledgerByCall.get(row.callId) ?? [];
    rows.push(row);
    ledgerByCall.set(row.callId, rows);
  }

  const failures = {
    negativeUsage: [] as string[],
    componentFormula: [] as string[],
    customerFormula: [] as string[],
    currency: [] as string[],
    missingUsage: [] as string[],
    unpriced: [] as string[],
    activeCatalogUnpriced: [] as string[],
    currentLedgerMismatch: [] as string[],
    duplicateClaims: [] as string[],
  };
  const versions = new Map<string, number>();
  let callsWithUsage = 0;
  let currentRevisionSettlements = 0;
  let legacySettlements = 0;

  for (const call of calls) {
    const id = String(call._id);
    const cost = call.costBreakdown;
    const usages = [
      call.durationSeconds, call.llmInputTokens, call.llmOutputTokens, call.llmTokens,
      call.sttInputTokens, call.sttOutputTokens, call.sttSeconds,
      call.ttsInputTokens, call.ttsOutputTokens, call.ttsAudioSeconds, call.ttsCharacters,
    ].map(number);
    if (usages.some((value) => value < 0)) failures.negativeUsage.push(id);
    const hasUsage = usages.slice(1).some((value) => value > 0) || (call.modelUsage?.length ?? 0) > 0;
    if (hasUsage) callsWithUsage += 1;
    if (number(call.durationSeconds) > 0 && !hasUsage) failures.missingUsage.push(id);

    if (cost) {
      const version = cost.calculationVersion || "(missing)";
      versions.set(version, (versions.get(version) ?? 0) + 1);
      if (cost.pricingStatus === "unpriced") failures.unpriced.push(id);
      if (cost.pricingStatus === "unpriced" &&
          ["2026-07-21-provider-cost-only-elevenlabs-voice-rates", MODEL_PRICING_VERSION].includes(version)) {
        failures.activeCatalogUnpriced.push(id);
      }
      const components = number(cost.llm) + number(cost.stt) + number(cost.tts) + number(cost.telephony);
      // Very old records predate the explicit provider/customer cost fields.
      // Preserve and report them, but validate only records written with the
      // modern cost schema rather than treating absent legacy fields as zero.
      const hasModernCostSchema = Boolean(cost.calculationVersion) && cost.pricingStatus !== "unpriced";
      if (hasModernCostSchema && cost.providerCost !== undefined && !close(number(cost.providerCost), components)) {
        failures.componentFormula.push(id);
      }
      if (hasModernCostSchema && cost.customerCost !== undefined &&
          (!close(number(cost.total), number(cost.customerCost)) ||
           !close(number(cost.customerCost), number(cost.providerCost) + number(cost.platformFee)))) {
          failures.customerFormula.push(id);
      }
      if (cost.currency !== "USD") failures.currency.push(id);
    }

    const rows = ledgerByCall.get(id) ?? [];
    const claims = rows.map((row) => row.deductionKey).filter(Boolean);
    if (new Set(claims).size !== claims.length) failures.duplicateClaims.push(id);
    if (!rows.length) continue;
    const revisions = rows
      .map((row) => number((row.metadata as Record<string, unknown> | undefined)?.billingUsageRevision))
      .filter((revision) => revision > 0);
    if (!revisions.length) {
      legacySettlements += 1;
      continue;
    }
    const lastRevision = Math.max(...revisions);
    if (lastRevision !== number(call.billingUsageRevision)) continue;
    currentRevisionSettlements += 1;
    const netCharged = -rows.reduce((sum, row) => sum + number(row.amountCredits), 0);
    if (!close(netCharged, number(cost?.total))) failures.currentLedgerMismatch.push(id);
  }

  const report = {
    terminalCalls: calls.length,
    callsWithProviderUsage: callsWithUsage,
    callLedgerRows: ledger.length,
    currentRevisionSettlements,
    legacySettlementsFrozen: legacySettlements,
    pricingVersions: Object.fromEntries([...versions.entries()].sort()),
    failures: Object.fromEntries(
      Object.entries(failures).map(([key, ids]) => [key, { count: ids.length, sampleIds: ids.slice(0, 5) }]),
    ),
  };
  console.log(JSON.stringify(report, null, 2));

  assert.equal(failures.negativeUsage.length, 0, "Negative provider usage exists");
  assert.equal(failures.componentFormula.length, 0, "Stored provider-cost component sums differ");
  assert.equal(failures.customerFormula.length, 0, "Stored customer-cost formulas differ");
  assert.equal(failures.currency.length, 0, "Non-USD call cost exists");
  assert.equal(failures.activeCatalogUnpriced.length, 0, "Unpriced calls exist on the active catalog");
  assert.equal(failures.currentLedgerMismatch.length, 0, "Current-revision ledger does not equal call cost");
  assert.equal(failures.duplicateClaims.length, 0, "Duplicate billing claims exist");
} finally {
  await mongoose.disconnect();
}
