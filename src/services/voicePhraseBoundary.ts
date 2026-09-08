/** A long, completed clause can reach TTS before the rest of its sentence. */
export function firstVoiceClauseBoundary(text: string): number | undefined {
  for (const match of text.matchAll(/[,;:]\s+/gu)) {
    const end = match.index! + 1;
    const prefix = text.slice(0, end);
    if (prefix.length < 48 || (prefix.match(/[\p{L}\p{M}]+/gu)?.length ?? 0) < 6) continue;
    // Do not break numeric lists, amounts, times, URL schemes or email tokens.
    if (/\p{N}$/u.test(text.slice(0, match.index)) || /^\s*\p{N}/u.test(text.slice(end))) continue;
    const lastWord = prefix.trim().split(/\s+/u).at(-1) ?? "";
    if (/@|:\/\/|^https?:/iu.test(lastWord)) continue;
    return end;
  }
  return undefined;
}
