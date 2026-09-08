import assert from "node:assert/strict";
import test from "node:test";

import { resolveVoiceTurnTuning } from "../src/services/voiceTurnTuning.js";

function tuning(overrides: Partial<Parameters<typeof resolveVoiceTurnTuning>[0]> = {}) {
  return resolveVoiceTurnTuning({
    endpointingMode: "fast",
    interruptionSensitivity: "medium",
    backgroundNoise: "none",
    responseDelayMs: 0,
    strategy: "vad",
    ...overrides,
  });
}

test("configures a silence window above 200ms for clean speech", () => {
  const clean = tuning();
  assert.equal(clean.vad.minSilenceDurationMs, 240);
  assert.equal(clean.realtimeSilenceDurationMs, 320);
  assert.equal(clean.endpointing.minDelay, 80);
});

test("increases speech protection for patient and noisy calls", () => {
  const clean = tuning();
  const balanced = tuning({ endpointingMode: "balanced" });
  const patient = tuning({ endpointingMode: "patient" });
  const street = tuning({ backgroundNoise: "street" });

  assert.ok(balanced.vad.minSilenceDurationMs > clean.vad.minSilenceDurationMs);
  assert.ok(patient.vad.minSilenceDurationMs > balanced.vad.minSilenceDurationMs);
  assert.ok(street.vad.activationThreshold > clean.vad.activationThreshold);
  assert.ok(street.interruptionMinDurationMs > clean.interruptionMinDurationMs);
  assert.ok(street.realtimeSilenceDurationMs > clean.realtimeSilenceDurationMs);
  assert.ok(street.realtimeVadThreshold > clean.realtimeVadThreshold);
});

test("does not add a second provider endpointing wait", () => {
  const provider = tuning({
    strategy: "provider_stt",
    endpointingMode: "balanced",
    backgroundNoise: "office",
    responseDelayMs: 300,
  });

  assert.equal(provider.endpointing.minDelay, 50);
  assert.equal(provider.endpointing.maxDelay, 350);
  assert.equal(provider.providerSilenceDurationMs, 800);
});

test("preserves enough pre-roll and silence for Exotel packets", () => {
  const exotel = tuning({ isExotelBridge: true });
  assert.equal(exotel.vad.minSilenceDurationMs, 240);
  assert.equal(exotel.vad.prefixPaddingMs, 320);
});

test("maps interruption sensitivity consistently across realtime providers", () => {
  const high = tuning({ interruptionSensitivity: "high", strategy: "realtime" });
  const low = tuning({ interruptionSensitivity: "low", strategy: "realtime" });

  assert.ok(high.interruptionMinDurationMs < low.interruptionMinDurationMs);
  assert.ok(high.realtimeVadThreshold < low.realtimeVadThreshold);
  assert.ok(high.sarvamRealtimeVadThreshold < low.sarvamRealtimeVadThreshold);
  assert.equal(high.falseInterruptionTimeoutMs, 900);
});
