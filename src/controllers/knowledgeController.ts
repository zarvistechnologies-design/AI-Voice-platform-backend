import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { KnowledgeSourceModel, type KnowledgeSourceDocument } from "../models/KnowledgeSource.js";
import { KnowledgeChunkModel } from "../models/KnowledgeChunk.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  disableKnowledgeSource,
  extractKnowledgeFile,
  fetchKnowledgeUrl,
  formatKnowledgeContext,
  indexKnowledgeSource,
  migrateLegacyKnowledgeDocuments,
  searchKnowledge,
  updateKnowledgeSourceContent,
} from "../services/knowledgeService.js";
import { HttpError } from "../utils/httpError.js";

const maximumSourcesPerAgent = 50;

function ownerId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

async function findAgent(request: AuthenticatedRequest) {
  const agent = await VoiceAgentModel.findOne({
    _id: request.params.agentId,
    ownerId: ownerId(request),
  });
  if (!agent) throw new HttpError(404, "Voice agent not found.");
  return agent;
}

async function findSource(request: AuthenticatedRequest, agent: VoiceAgentDocument) {
  const source = await KnowledgeSourceModel.findOne({
    _id: request.params.sourceId,
    agentId: agent._id,
    ownerId: ownerId(request),
  });
  if (!source) throw new HttpError(404, "Knowledge source not found.");
  return source;
}

function sourceJson(source: KnowledgeSourceDocument, includeContent = false) {
  return {
    _id: source.id,
    name: source.name,
    sourceType: source.sourceType,
    status: source.status,
    originalFileName: source.originalFileName,
    mimeType: source.mimeType,
    url: source.url,
    characterCount: source.characterCount,
    chunkCount: source.chunkCount,
    embeddingModel: source.embeddingModel,
    error: source.error,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    preview: source.content.slice(0, 280),
    ...(includeContent ? { content: source.content } : {}),
  };
}

async function assertSourceCapacity(agent: VoiceAgentDocument) {
  const count = await KnowledgeSourceModel.countDocuments({ agentId: agent._id });
  if (count >= maximumSourcesPerAgent) {
    throw new HttpError(409, `An agent can have at most ${maximumSourcesPerAgent} knowledge sources.`);
  }
}

async function refreshSourceCount(agent: VoiceAgentDocument) {
  const count = await KnowledgeSourceModel.countDocuments({ agentId: agent._id });
  if (agent.knowledgeSourceCount !== count) {
    agent.knowledgeSourceCount = count;
    await agent.save();
  }
  return count;
}

export async function listKnowledgeSources(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  try {
    await migrateLegacyKnowledgeDocuments(agent);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "legacy-knowledge-migration-failed",
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const sources = await KnowledgeSourceModel.find({ agentId: agent._id, ownerId: ownerId(request) }).sort({ createdAt: -1 });
  await refreshSourceCount(agent);
  response.json({ sources: sources.map((source) => sourceJson(source)), maximumSources: maximumSourcesPerAgent });
}

export async function getKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const source = await findSource(request, agent);
  response.json({ source: sourceJson(source, true) });
}

export async function addTextKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  await assertSourceCapacity(agent);
  const name = String(request.body.name ?? "").trim();
  const content = String(request.body.content ?? "");
  if (!name) throw new HttpError(400, "Give this knowledge source a name.");
  const source = await createKnowledgeSource({ ownerId: ownerId(request), agentId: agent._id, name, content, sourceType: "text" });
  await refreshSourceCount(agent);
  response.status(201).json({ source: sourceJson(source, true) });
}

export async function addUrlKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  await assertSourceCapacity(agent);
  const requestedUrl = String(request.body.url ?? "").trim();
  if (!requestedUrl) throw new HttpError(400, "Enter a website URL.");
  const fetched = await fetchKnowledgeUrl(requestedUrl);
  const name = String(request.body.name ?? "").trim() || new URL(fetched.url).hostname;
  const source = await createKnowledgeSource({
    ownerId: ownerId(request),
    agentId: agent._id,
    name,
    content: fetched.content,
    sourceType: "url",
    url: fetched.url,
    mimeType: "text/html",
  });
  await refreshSourceCount(agent);
  response.status(201).json({ source: sourceJson(source, true) });
}

export async function addFileKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  await assertSourceCapacity(agent);
  if (!request.file) throw new HttpError(400, "Choose a knowledge file to upload.");
  const content = await extractKnowledgeFile(request.file);
  const requestedName = String(request.body.name ?? "").trim();
  const fallbackName = request.file.originalname.replace(/\.[^.]+$/, "");
  const source = await createKnowledgeSource({
    ownerId: ownerId(request),
    agentId: agent._id,
    name: requestedName || fallbackName,
    content,
    sourceType: "file",
    originalFileName: request.file.originalname,
    mimeType: request.file.mimetype,
  });
  await refreshSourceCount(agent);
  response.status(201).json({ source: sourceJson(source, true) });
}

export async function updateKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const source = await findSource(request, agent);
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  if (name) source.name = name.slice(0, 200);
  if (typeof request.body.content === "string") {
    if (!["text", "legacy"].includes(source.sourceType)) {
      throw new HttpError(400, "File and website sources must be re-indexed from their original source.");
    }
    await updateKnowledgeSourceContent(source, request.body.content, name);
  } else if (request.body.status === "disabled") {
    await disableKnowledgeSource(source);
  } else if (request.body.status === "ready" && source.status !== "ready") {
    await indexKnowledgeSource(source);
  } else {
    await source.save();
    await KnowledgeChunkModel.updateMany({ sourceId: source._id }, { sourceName: source.name });
  }
  response.json({ source: sourceJson(source, true) });
}

export async function reindexKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const source = await findSource(request, agent);
  if (source.sourceType === "url") {
    const fetched = await fetchKnowledgeUrl(source.url);
    source.url = fetched.url;
    await updateKnowledgeSourceContent(source, fetched.content);
  } else {
    await indexKnowledgeSource(source);
  }
  response.json({ source: sourceJson(source, true) });
}

export async function removeKnowledgeSource(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const source = await findSource(request, agent);
  if (source.sourceType === "legacy" && source.legacyDocumentId) {
    agent.set("knowledgeDocuments", agent.knowledgeDocuments.filter(
      (document) => String(document._id) !== source.legacyDocumentId,
    ));
    await agent.save();
  }
  await deleteKnowledgeSource(source);
  await refreshSourceCount(agent);
  response.status(204).end();
}

export async function testKnowledgeSearch(request: AuthenticatedRequest, response: Response) {
  const agent = await findAgent(request);
  const query = String(request.body.query ?? "").trim();
  if (!query) throw new HttpError(400, "Enter a question to test the knowledge base.");
  const results = await searchKnowledge({ ownerId: ownerId(request), agentId: agent._id, query });
  response.json({ query, results, context: formatKnowledgeContext(results) });
}
