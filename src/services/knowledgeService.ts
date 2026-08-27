import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import mammoth from "mammoth";
import mongoose, { Types } from "mongoose";
import pdf from "pdf-parse/lib/pdf-parse.js";

import { env } from "../config/env.js";
import { KnowledgeChunkModel } from "../models/KnowledgeChunk.js";
import {
  KnowledgeSourceModel,
  type KnowledgeSourceDocument,
} from "../models/KnowledgeSource.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";

const maxSourceCharacters = 2_000_000;
const maxRemoteBytes = 5 * 1024 * 1024;
const targetChunkCharacters = 2_600;
const chunkOverlapCharacters = 350;

export type KnowledgeSearchResult = {
  sourceId: string;
  sourceName: string;
  content: string;
  score: number;
};

type EmbeddedResponse = {
  data?: { index: number; embedding: number[] }[];
  error?: { message?: string };
};

type GoogleEmbeddedResponse = {
  embeddings?: { values?: number[] }[];
  error?: { message?: string };
};

type KnowledgeEmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

function normalizeText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ \u00a0]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function splitOversizedBlock(block: string) {
  if (block.length <= targetChunkCharacters) return [block];
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  if (sentences.length === 1) {
    const pieces: string[] = [];
    for (let offset = 0; offset < block.length; offset += targetChunkCharacters - chunkOverlapCharacters) {
      pieces.push(block.slice(offset, offset + targetChunkCharacters));
    }
    return pieces;
  }
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > targetChunkCharacters) {
      pieces.push(current.trim());
      current = `${current.slice(-chunkOverlapCharacters)} ${sentence}`;
    } else {
      current = `${current} ${sentence}`;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

export function chunkKnowledgeText(input: string) {
  const text = normalizeText(input);
  if (!text) return [];
  const blocks = text
    .split(/\n\s*\n/)
    .flatMap((block) => splitOversizedBlock(block.trim()))
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > targetChunkCharacters) {
      chunks.push(current.trim());
      current = `${current.slice(-chunkOverlapCharacters)}\n\n${block}`;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function knowledgeContentHash(content: string) {
  return createHash("sha256").update(normalizeText(content)).digest("hex");
}

function embeddingModelLabel() {
  return `${env.knowledgeEmbeddingProvider}:${env.knowledgeEmbeddingModel}:${env.knowledgeEmbeddingDimensions}`;
}

async function embedOpenAiBatch(input: string[], timeoutMs = env.knowledgeEmbeddingTimeoutMs) {
  if (!env.openaiApiKey) {
    throw new HttpError(503, "Knowledge indexing requires OPENAI_API_KEY.");
  }
  const response = await fetch(`${env.openaiBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: env.knowledgeEmbeddingModel, input, dimensions: env.knowledgeEmbeddingDimensions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as EmbeddedResponse;
  if (!response.ok || !Array.isArray(payload.data)) {
    throw new Error(payload.error?.message || `Embedding provider returned HTTP ${response.status}.`);
  }
  const ordered = [...payload.data].sort((left, right) => left.index - right.index);
  if (ordered.length !== input.length || ordered.some((item) => !Array.isArray(item.embedding))) {
    throw new Error("Embedding provider returned an incomplete result.");
  }
  return ordered.map((item) => item.embedding);
}

async function embedGoogleBatch(
  input: string[],
  taskType: KnowledgeEmbeddingTask,
  timeoutMs = env.knowledgeEmbeddingTimeoutMs,
) {
  if (!env.googleApiKey) {
    throw new HttpError(503, "Knowledge indexing requires GOOGLE_API_KEY.");
  }
  const model = env.knowledgeEmbeddingModel.replace(/^models\//, "");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.googleApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: input.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: env.knowledgeEmbeddingDimensions,
      })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as GoogleEmbeddedResponse;
  if (!response.ok || !Array.isArray(payload.embeddings)) {
    throw new Error(payload.error?.message || `Google embedding provider returned HTTP ${response.status}.`);
  }
  const embeddings = payload.embeddings.map((item) => item.values ?? []);
  if (embeddings.length !== input.length || embeddings.some((embedding) => embedding.length !== env.knowledgeEmbeddingDimensions)) {
    throw new Error("Google embedding provider returned an incomplete result.");
  }
  return embeddings;
}

async function embedBatch(input: string[], taskType: KnowledgeEmbeddingTask, timeoutMs?: number) {
  return env.knowledgeEmbeddingProvider === "google"
    ? embedGoogleBatch(input, taskType, timeoutMs)
    : embedOpenAiBatch(input, timeoutMs);
}

export async function embedKnowledgeTexts(
  texts: string[],
  taskType: KnowledgeEmbeddingTask = "RETRIEVAL_DOCUMENT",
  timeoutMs = env.knowledgeEmbeddingTimeoutMs,
) {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += env.knowledgeEmbeddingBatchSize) {
    embeddings.push(...await embedBatch(
      texts.slice(offset, offset + env.knowledgeEmbeddingBatchSize),
      taskType,
      timeoutMs,
    ));
  }
  return embeddings;
}

function publicIndexError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}

export async function indexKnowledgeSource(source: KnowledgeSourceDocument) {
  source.status = "processing";
  source.error = "";
  await source.save();
  try {
    const chunks = chunkKnowledgeText(source.content);
    if (!chunks.length) throw new HttpError(400, "The knowledge source does not contain readable text.");
    const embeddings = await embedKnowledgeTexts(chunks);
    const documents = chunks.map((content, chunkIndex) => ({
      ownerId: source.ownerId,
      agentId: source.agentId,
      sourceId: source._id,
      sourceName: source.name,
      chunkIndex,
      content,
      characterCount: content.length,
      embeddingModel: embeddingModelLabel(),
      embedding: embeddings[chunkIndex],
    }));
    await KnowledgeChunkModel.deleteMany({ sourceId: source._id });
    await KnowledgeChunkModel.insertMany(documents);
    source.status = "ready";
    source.chunkCount = chunks.length;
    source.characterCount = source.content.length;
    source.embeddingModel = embeddingModelLabel();
    source.error = "";
    await source.save();
    return source;
  } catch (error) {
    await KnowledgeChunkModel.deleteMany({ sourceId: source._id });
    source.status = "failed";
    source.chunkCount = 0;
    source.error = publicIndexError(error);
    await source.save();
    throw error;
  }
}

export function prepareKnowledgeContent(content: string) {
  const normalized = normalizeText(content);
  if (!normalized) throw new HttpError(400, "Knowledge content cannot be empty.");
  if (normalized.length > maxSourceCharacters) {
    throw new HttpError(413, `Knowledge content must be under ${maxSourceCharacters.toLocaleString()} characters.`);
  }
  return normalized;
}

export async function createKnowledgeSource(input: {
  ownerId: string;
  agentId: Types.ObjectId;
  name: string;
  sourceType: "text" | "file" | "url" | "legacy";
  content: string;
  originalFileName?: string;
  mimeType?: string;
  url?: string;
  legacyDocumentId?: string;
}) {
  const content = prepareKnowledgeContent(input.content);
  const source = await KnowledgeSourceModel.create({
    ...input,
    name: input.name.trim().slice(0, 200),
    content,
    contentHash: knowledgeContentHash(content),
    characterCount: content.length,
    status: "processing",
  });
  try {
    return await indexKnowledgeSource(source);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `Knowledge source could not be indexed: ${publicIndexError(error)}`);
  }
}

export async function updateKnowledgeSourceContent(
  source: KnowledgeSourceDocument,
  content: string,
  name?: string,
) {
  const prepared = prepareKnowledgeContent(content);
  source.content = prepared;
  source.contentHash = knowledgeContentHash(prepared);
  source.characterCount = prepared.length;
  if (name?.trim()) source.name = name.trim().slice(0, 200);
  return indexKnowledgeSource(source);
}

export async function disableKnowledgeSource(source: KnowledgeSourceDocument) {
  source.status = "disabled";
  source.error = "";
  await KnowledgeChunkModel.deleteMany({ sourceId: source._id });
  await source.save();
  return source;
}

export async function deleteKnowledgeSource(source: KnowledgeSourceDocument) {
  await Promise.all([
    KnowledgeChunkModel.deleteMany({ sourceId: source._id }),
    source.deleteOne(),
  ]);
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIp(address: string) {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice("::ffff:".length));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb");
}

async function safeRemoteUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a valid website URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, "Only public HTTP or HTTPS URLs are supported.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new HttpError(400, "The website URL must resolve to a public address.");
  }
  return url;
}

function decodeHtmlEntities(value: string) {
  const entities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string) {
  return normalizeText(decodeHtmlEntities(html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|section|article|main|header|footer|aside|nav|li|h[1-6]|tr|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")));
}

export async function fetchKnowledgeUrl(value: string) {
  let url = await safeRemoteUrl(value);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "AI-Voice-Knowledge-Indexer/1.0", Accept: "text/html,text/plain,application/json,application/xml,text/csv" },
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === 4) throw new HttpError(400, "The website redirected too many times.");
      url = await safeRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new HttpError(400, `The website returned HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > maxRemoteBytes) throw new HttpError(413, "Website content is larger than 5MB.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxRemoteBytes) throw new HttpError(413, "Website content is larger than 5MB.");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/(text\/|html|json|xml|csv)/.test(contentType)) {
      throw new HttpError(415, "That URL does not contain a supported text or HTML page.");
    }
    const raw = bytes.toString("utf8");
    return { content: contentType.includes("html") ? htmlToText(raw) : normalizeText(raw), url: url.toString() };
  }
  throw new HttpError(400, "Could not load the website.");
}

export async function extractKnowledgeFile(file: Express.Multer.File) {
  const extension = file.originalname.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf" || file.mimetype === "application/pdf") {
    const result = await pdf(file.buffer);
    return prepareKnowledgeContent(result.text);
  }
  if (extension === "docx" || file.mimetype.includes("wordprocessingml")) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return prepareKnowledgeContent(result.value);
  }
  if (["txt", "md", "csv", "json", "html", "htm", "xml"].includes(extension) || file.mimetype.startsWith("text/")) {
    const raw = file.buffer.toString("utf8");
    return prepareKnowledgeContent(["html", "htm"].includes(extension) ? htmlToText(raw) : raw);
  }
  throw new HttpError(415, "Upload a PDF, DOCX, TXT, Markdown, CSV, JSON, HTML, or XML file.");
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
}

function lexicalScore(query: string, content: string) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!terms.length) return 0;
  const haystack = content.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

async function fallbackSearch(
  ownerId: string,
  agentId: Types.ObjectId,
  query: string,
  queryEmbedding: number[] | null,
  limit: number,
  maxChunks?: number,
) {
  const chunkQuery = KnowledgeChunkModel.find({ ownerId, agentId, embeddingModel: embeddingModelLabel() })
    // Lexical fallback does not need large embedding arrays from MongoDB.
    .select(queryEmbedding?.length
      ? "sourceId sourceName content embeddingModel +embedding"
      : "sourceId sourceName content embeddingModel");
  if (maxChunks) chunkQuery.limit(maxChunks);
  const chunks = await chunkQuery.lean();
  const scored = chunks
    .map((chunk) => ({
      sourceId: String(chunk.sourceId),
      sourceName: chunk.sourceName,
      content: chunk.content,
      score: queryEmbedding?.length ? cosineSimilarity(queryEmbedding, chunk.embedding) : lexicalScore(query, chunk.content),
    }))
    .filter((result) => result.score >= (queryEmbedding?.length ? env.knowledgeMinimumScore : 0.2))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  if (scored.length) return scored;

  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId }).select("knowledgeDocuments").lean();
  const legacyChunks: Array<{ sourceId: string; sourceName: string; content: string }> = [];
  legacyDocuments: for (const document of agent?.knowledgeDocuments ?? []) {
    if (document.status !== "ready") continue;
    for (const content of chunkKnowledgeText(document.content)) {
      legacyChunks.push({
        sourceId: String(document._id),
        sourceName: document.name,
        content,
      });
      if (maxChunks && legacyChunks.length >= maxChunks) break legacyDocuments;
    }
  }
  return legacyChunks
    .map((chunk) => ({ ...chunk, score: lexicalScore(query, chunk.content) }))
    .filter((result) => result.score >= 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export async function searchKnowledge(input: {
  ownerId: string;
  agentId: string | Types.ObjectId;
  query: string;
  limit?: number;
  embeddingTimeoutMs?: number;
  fallbackMaxChunks?: number;
}) {
  const query = normalizeText(input.query).slice(0, 4000);
  if (!query || !Types.ObjectId.isValid(input.agentId)) return [];
  const agentId = new Types.ObjectId(input.agentId);
  const limit = Math.min(10, Math.max(1, input.limit ?? env.knowledgeTopK));
  let queryEmbedding: number[] | null = null;
  try {
    [queryEmbedding] = await embedKnowledgeTexts(
      [query],
      "RETRIEVAL_QUERY",
      input.embeddingTimeoutMs,
    );
  } catch (error) {
    const payload = JSON.stringify({
      event: input.embeddingTimeoutMs
        ? "knowledge-query-embedding-time-budget-exhausted"
        : "knowledge-query-embedding-failed",
      agentId: String(agentId),
      timeoutMs: input.embeddingTimeoutMs,
      error: publicIndexError(error),
    });
    if (input.embeddingTimeoutMs) console.debug(payload);
    else console.warn(payload);
  }

  if (queryEmbedding?.length && env.knowledgeVectorIndex) {
    try {
      const results = await KnowledgeChunkModel.aggregate<KnowledgeSearchResult>([
        {
          $vectorSearch: {
            index: env.knowledgeVectorIndex,
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: Math.max(100, limit * 20),
            limit,
            filter: { ownerId: input.ownerId, agentId, embeddingModel: embeddingModelLabel() },
          },
        },
        {
          $project: {
            _id: 0,
            sourceId: { $toString: "$sourceId" },
            sourceName: 1,
            content: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
        { $match: { score: { $gte: env.knowledgeMinimumScore } } },
      ]);
      if (results.length) return results;
    } catch (error) {
      if (env.nodeEnv === "development") {
        console.warn(JSON.stringify({ event: "knowledge-vector-search-fallback", error: publicIndexError(error) }));
      }
    }
  }
  return fallbackSearch(
    input.ownerId,
    agentId,
    query,
    queryEmbedding,
    limit,
    input.fallbackMaxChunks,
  );
}

export function formatKnowledgeContext(
  results: KnowledgeSearchResult[],
  maxCharacters = env.knowledgeMaxContextCharacters,
) {
  if (!results.length) return "";
  const context = results.map((result, index) =>
    `[Source ${index + 1}: ${result.sourceName}]\n${result.content}`,
  ).join("\n\n");
  return context.slice(0, maxCharacters);
}

export async function migrateLegacyKnowledgeDocuments(agent: VoiceAgentDocument) {
  for (const document of agent.knowledgeDocuments) {
    try {
      const legacyDocumentId = String(document._id);
      const content = prepareKnowledgeContent(document.content);
      const hash = knowledgeContentHash(content);
      const existing = await KnowledgeSourceModel.findOne({ agentId: agent._id, legacyDocumentId });
      if (document.status === "disabled") {
        if (existing && existing.status !== "disabled") await disableKnowledgeSource(existing);
        continue;
      }
      if (existing?.contentHash === hash && existing.status === "ready") continue;
      if (existing) {
        existing.name = document.name;
        existing.content = content;
        existing.contentHash = hash;
        existing.characterCount = content.length;
        await indexKnowledgeSource(existing);
      } else {
        await createKnowledgeSource({
          ownerId: agent.ownerId,
          agentId: agent._id,
          name: document.name,
          sourceType: "legacy",
          content,
          legacyDocumentId,
        });
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: "legacy-knowledge-source-migration-failed",
        agentId: agent.id,
        documentId: String(document._id),
        error: publicIndexError(error),
      }));
    }
  }
}

export async function deleteAgentKnowledge(agentId: mongoose.Types.ObjectId) {
  await Promise.all([
    KnowledgeChunkModel.deleteMany({ agentId }),
    KnowledgeSourceModel.deleteMany({ agentId }),
  ]);
}

export async function cloneAgentKnowledge(
  sourceAgentId: mongoose.Types.ObjectId,
  targetAgent: VoiceAgentDocument,
) {
  const sources = await KnowledgeSourceModel.find({ agentId: sourceAgentId, sourceType: { $ne: "legacy" } });
  for (const source of sources) {
    const sourceCopy = source.toObject() as Record<string, unknown>;
    delete sourceCopy._id;
    delete sourceCopy.createdAt;
    delete sourceCopy.updatedAt;
    const clonedSource = await KnowledgeSourceModel.create({
      ...sourceCopy,
      agentId: targetAgent._id,
      ownerId: targetAgent.ownerId,
    });
    const chunks = await KnowledgeChunkModel.find({ sourceId: source._id }).select("+embedding").lean();
    if (chunks.length) {
      await KnowledgeChunkModel.insertMany(chunks.map((chunk) => ({
        ownerId: targetAgent.ownerId,
        agentId: targetAgent._id,
        sourceId: clonedSource._id,
        sourceName: clonedSource.name,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        characterCount: chunk.characterCount,
        embeddingModel: chunk.embeddingModel,
        embedding: chunk.embedding,
      })));
    }
  }
  targetAgent.knowledgeSourceCount = sources.length;
  await targetAgent.save();
}
