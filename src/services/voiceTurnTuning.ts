import type { PipelineTurnStrategy } from "./voiceLatencyPolicy.js";

export type VoiceEndpointingMode = "fast" | "balanced" | "patient";
export type VoiceInterruptionSensitivity = "low" | "medium" | "high";
export type VoiceBackgroundNoise = "none" | "office" | "cafe" | "street";
export type VoiceTurnStrategy = PipelineTurnStrategy | "realtime";

export type VoiceTurnTuning = {
  endpointing: { minDelay: number; maxDelay: number };
  interruptionMinDurationMs: number;
  falseInterruptionTimeoutMs: number;
  providerSilenceDurationMs: number;
  realtimeSilenceDurationMs: number;
  realtimeVadThreshold: number;
  sarvamRealtimeVadThreshold: number;
  vad: {
    activationThreshold: number;
    minSpeechDurationMs: number;
    minSilenceDurationMs: number;
    prefixPaddingMs: number;
  };
};

type BackgroundProfile = {
  realtimeVadThresholdOffset: number;
  sarvamVadThresholdOffset: number;
  vadActivationThreshold: number;
  vadMinSpeechDurationMs: number;
  vadMinSilenceDurationMs: number;
  vadPrefixPaddingMs: number;
  interruptionMinDurationOffsetMs: number;
  endpointingDelayOffsetMs: number;
};

const backgroundProfiles: Record<VoiceBackgroundNoise, BackgroundProfile> = {
  none: {
    realtimeVadThresholdOffset: 0,
    sarvamVadThresholdOffset: 0,
    vadActivationThreshold: 0.48,
    vadMinSpeechDurationMs: 80,
    // 150 ms split ordinary phrase pauses. 240 ms remains responsive without
    // treating every breath or stop consonant as the end of the caller's turn.
    vadMinSilenceDurationMs: 240,
    vadPrefixPaddingMs: 420,
    interruptionMinDurationOffsetMs: 0,
    endpointingDelayOffsetMs: 0,
  },
  office: {
    realtimeVadThresholdOffset: 0.04,
    sarvamVadThresholdOffset: 0.04,
    vadActivationThreshold: 0.54,
    vadMinSpeechDurationMs: 100,
    vadMinSilenceDurationMs: 380,
    vadPrefixPaddingMs: 400,
    interruptionMinDurationOffsetMs: 80,
    endpointingDelayOffsetMs: 60,
  },
  cafe: {
    realtimeVadThresholdOffset: 0.08,
    sarvamVadThresholdOffset: 0.08,
    vadActivationThreshold: 0.6,
    vadMinSpeechDurationMs: 140,
    vadMinSilenceDurationMs: 520,
    vadPrefixPaddingMs: 380,
    interruptionMinDurationOffsetMs: 160,
    endpointingDelayOffsetMs: 120,
  },
  street: {
    realtimeVadThresholdOffset: 0.12,
    sarvamVadThresholdOffset: 0.12,
    vadActivationThreshold: 0.65,
    vadMinSpeechDurationMs: 180,
    vadMinSilenceDurationMs: 650,
    vadPrefixPaddingMs: 360,
    interruptionMinDurationOffsetMs: 240,
    endpointingDelayOffsetMs: 180,
  },
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Resolve one coherent turn-taking profile for local VAD, provider VAD,
 * endpointing, and interruptions. Keeping these values together prevents two
 * separate silence windows from accidentally being added to the same turn.
 */
export function resolveVoiceTurnTuning(input: {
  endpointingMode: VoiceEndpointingMode;
  interruptionSensitivity: VoiceInterruptionSensitivity;
  backgroundNoise: VoiceBackgroundNoise;
  responseDelayMs: number;
  strategy: VoiceTurnStrategy;
  isExotelBridge?: boolean;
}): VoiceTurnTuning {
  const profile = backgroundProfiles[input.backgroundNoise];
  const requestedDelayMs = clamp(finiteNonNegative(input.responseDelayMs), 0, 1_200);
  const modeSilenceOffsetMs = input.endpointingMode === "patient"
    ? 320
    : input.endpointingMode === "balanced" ? 120 : 0;
  let vadMinSilenceDurationMs = profile.vadMinSilenceDurationMs + modeSilenceOffsetMs;
  let vadPrefixPaddingMs = profile.vadPrefixPaddingMs;

  if (input.strategy === "semantic_audio") {
    // The semantic detector begins evaluating after 200 ms. Keep its clean
    // audio floor small while retaining the selected protection for noise.
    vadMinSilenceDurationMs = Math.max(250, profile.vadMinSilenceDurationMs);
  } else if (input.isExotelBridge && input.backgroundNoise === "none") {
    // Exotel contributes a media packet window of its own. Avoid duplicating
    // the full browser/SIP pause while still preserving natural word gaps.
    vadMinSilenceDurationMs = 240 + modeSilenceOffsetMs;
    vadPrefixPaddingMs = 320;
  }

  const endpointBaseMs = requestedDelayMs + profile.endpointingDelayOffsetMs;
  let endpointing: VoiceTurnTuning["endpointing"];
  if (input.strategy === "flux_stt") {
    const minDelay = clamp(Math.max(50, requestedDelayMs), 50, 1_200);
    endpointing = { minDelay, maxDelay: Math.max(350, minDelay + 250) };
  } else if (input.strategy === "provider_stt") {
    // Provider EOT is already delayed by providerSilenceDurationMs below. Only
    // debounce the final event here; adding the same delay twice harms latency.
    const minDelay = 50;
    endpointing = { minDelay, maxDelay: 350 };
  } else if (input.strategy === "semantic_audio") {
    const modeFloor = input.endpointingMode === "patient"
      ? 450
      : input.endpointingMode === "balanced" ? 320 : 250;
    const minDelay = clamp(Math.max(modeFloor, endpointBaseMs), modeFloor, 1_200);
    const maxDelay = input.endpointingMode === "patient"
      ? Math.max(2_500, minDelay + 1_800)
      : input.endpointingMode === "balanced"
        ? Math.max(1_600, minDelay + 1_000)
        : Math.max(1_200, minDelay + 700);
    endpointing = { minDelay, maxDelay };
  } else {
    const modeFloor = input.endpointingMode === "patient"
      ? 350
      : input.endpointingMode === "balanced" ? 180 : 80;
    const minDelay = clamp(Math.max(modeFloor, endpointBaseMs), modeFloor, 1_200);
    const maxDelay = input.endpointingMode === "patient"
      ? Math.max(1_400, minDelay + 1_000)
      : input.endpointingMode === "balanced"
        ? Math.max(800, minDelay + 600)
        : Math.max(500, minDelay + 300);
    endpointing = { minDelay, maxDelay };
  }

  const interruptionBaseMs = input.interruptionSensitivity === "high"
    ? 160
    : input.interruptionSensitivity === "low" ? 520 : 300;
  const realtimeThresholdBase = input.interruptionSensitivity === "high"
    ? 0.4
    : input.interruptionSensitivity === "low" ? 0.66 : 0.52;
  const sarvamThresholdBase = input.interruptionSensitivity === "high"
    ? 0.24
    : input.interruptionSensitivity === "low" ? 0.38 : 0.3;
  const providerSilenceDurationMs = clamp(
    profile.vadMinSilenceDurationMs
      + modeSilenceOffsetMs
      + (input.strategy === "provider_stt" ? requestedDelayMs : 0),
    200,
    2_000,
  );
  const realtimeModeFloorMs = input.endpointingMode === "patient"
    ? 750
    : input.endpointingMode === "balanced" ? 500 : 320;
  const realtimeSilenceDurationMs = clamp(
    Math.max(
      realtimeModeFloorMs,
      profile.vadMinSilenceDurationMs + modeSilenceOffsetMs,
      requestedDelayMs + profile.endpointingDelayOffsetMs,
    ),
    300,
    1_400,
  );

  return {
    endpointing,
    interruptionMinDurationMs:
      interruptionBaseMs + profile.interruptionMinDurationOffsetMs,
    // LiveKit resumes paused speech when no transcript follows. Two seconds is
    // conspicuous in conversation; this still leaves STT ample time to arrive.
    falseInterruptionTimeoutMs:
      900 + Math.round(profile.interruptionMinDurationOffsetMs * 1.5),
    providerSilenceDurationMs,
    realtimeSilenceDurationMs,
    realtimeVadThreshold: clamp(
      realtimeThresholdBase + profile.realtimeVadThresholdOffset,
      0.35,
      0.82,
    ),
    sarvamRealtimeVadThreshold: clamp(
      sarvamThresholdBase + profile.sarvamVadThresholdOffset,
      0.2,
      0.7,
    ),
    vad: {
      activationThreshold: profile.vadActivationThreshold,
      minSpeechDurationMs: profile.vadMinSpeechDurationMs,
      minSilenceDurationMs: vadMinSilenceDurationMs,
      prefixPaddingMs: vadPrefixPaddingMs,
    },
  };
}
