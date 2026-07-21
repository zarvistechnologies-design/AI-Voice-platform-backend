const voiceRateMultipliers = new Map<string, number>();

export function rememberElevenLabsVoiceRate(voiceId: string, rate: number | undefined) {
  const normalizedVoiceId = voiceId.trim();
  if (!normalizedVoiceId || rate === undefined || !Number.isFinite(rate) || rate <= 0) return;
  voiceRateMultipliers.set(normalizedVoiceId, rate);
}

export function elevenLabsVoiceRate(voiceId: string) {
  return voiceRateMultipliers.get(voiceId.trim());
}
