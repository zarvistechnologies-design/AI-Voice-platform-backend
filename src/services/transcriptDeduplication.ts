const legacySttItemPrefix = "user-final-";
const duplicateWindowMs = 2_000;

type TranscriptItem = {
  itemId: string;
  role: string;
  text: string;
  timestamp: string;
};

function normalizedText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function isLegacySttItem(item: TranscriptItem) {
  return item.role === "user" && item.itemId.startsWith(legacySttItemPrefix);
}

function isLegacyDuplicate(left: TranscriptItem, right: TranscriptItem) {
  if (left.role !== "user" || right.role !== "user") return false;
  if (normalizedText(left.text) !== normalizedText(right.text)) return false;
  if (!isLegacySttItem(left) && !isLegacySttItem(right)) return false;

  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  return Number.isFinite(leftTime)
    && Number.isFinite(rightTime)
    && Math.abs(leftTime - rightTime) <= duplicateWindowMs;
}

/**
 * Older pipeline calls stored the same turn once from final STT and again from
 * the committed conversation item. Collapse only that known pair so genuine
 * repeated user messages remain visible.
 */
export function dedupeLegacyUserTranscriptItems<T extends TranscriptItem>(items: T[]) {
  const deduped: T[] = [];

  for (const item of items) {
    const previous = deduped.at(-1);
    if (!previous || !isLegacyDuplicate(previous, item)) {
      deduped.push(item);
      continue;
    }

    // Prefer the canonical committed conversation item over the provisional
    // legacy STT item, regardless of which asynchronous write finished first.
    if (isLegacySttItem(previous) && !isLegacySttItem(item)) {
      deduped[deduped.length - 1] = item;
    }
  }

  return deduped;
}
