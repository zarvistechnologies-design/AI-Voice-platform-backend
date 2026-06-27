export type KnowledgeRetrievalDocument = {
  name: string;
  content: string;
  status?: "ready" | "disabled";
};

type KnowledgeChunk = {
  documentName: string;
  text: string;
  index: number;
};

const maxChunkCharacters = 900;
const maxReturnedCharacters = 3600;
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
  "your",
]);

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function tokens(value: string) {
  return [...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match[0])
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function splitLongText(text: string) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChunkCharacters) {
    chunks.push(text.slice(index, index + maxChunkCharacters));
  }
  return chunks;
}

export function buildKnowledgeChunks(
  documents: readonly KnowledgeRetrievalDocument[],
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];

  for (const document of documents) {
    if (document.status === "disabled") continue;
    const sections = document.content
      .split(/\n{2,}|(?=^#{1,4}\s+)/m)
      .map(normalizeText)
      .filter(Boolean);

    let buffer = "";
    let chunkIndex = 0;
    const push = (text: string) => {
      for (const piece of splitLongText(text)) {
        const clean = normalizeText(piece);
        if (!clean) continue;
        chunks.push({
          documentName: document.name,
          text: clean,
          index: chunkIndex,
        });
        chunkIndex += 1;
      }
    };

    for (const section of sections.length ? sections : [document.content]) {
      if ((buffer + " " + section).trim().length > maxChunkCharacters) {
        if (buffer) push(buffer);
        buffer = section;
      } else {
        buffer = `${buffer} ${section}`.trim();
      }
    }
    if (buffer) push(buffer);
  }

  return chunks;
}

function scoreChunk(chunk: KnowledgeChunk, queryTokens: readonly string[], query: string) {
  const text = `${chunk.documentName} ${chunk.text}`.toLowerCase();
  const uniqueQueryTokens = [...new Set(queryTokens)];
  let score = 0;

  if (query.length >= 4 && text.includes(query.toLowerCase())) {
    score += 10;
  }

  for (const token of uniqueQueryTokens) {
    const occurrences = text.split(token).length - 1;
    if (!occurrences) continue;
    score += Math.min(occurrences, 4);
    if (chunk.documentName.toLowerCase().includes(token)) score += 2;
  }

  return score;
}

export function searchKnowledgeBase(
  documents: readonly KnowledgeRetrievalDocument[],
  query: string,
  limit = 4,
) {
  const cleanQuery = normalizeText(query);
  const queryTokens = tokens(cleanQuery);
  const chunks = buildKnowledgeChunks(documents);

  if (!chunks.length) {
    return {
      query: cleanQuery,
      matches: [],
      message: "No active knowledge documents are attached to this agent.",
    };
  }

  if (!queryTokens.length && cleanQuery.length < 3) {
    return {
      query: cleanQuery,
      matches: [],
      message: "Ask a specific knowledge-base question to search the attached documents.",
    };
  }

  let usedCharacters = 0;
  const matches = chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, queryTokens, cleanQuery) }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score || left.documentName.localeCompare(right.documentName))
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map((chunk) => {
      const remaining = maxReturnedCharacters - usedCharacters;
      const text = chunk.text.slice(0, Math.max(0, remaining));
      usedCharacters += text.length;
      return {
        documentName: chunk.documentName,
        chunk: chunk.index + 1,
        text,
      };
    })
    .filter((chunk) => chunk.text);

  return {
    query: cleanQuery,
    matches,
    message: matches.length
      ? "Use only these retrieved knowledge snippets for the factual answer."
      : "No matching knowledge was found. Say the answer is not available in the knowledge base and offer a human handoff.",
  };
}
