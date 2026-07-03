import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { KnowledgeChunkModel } from "../src/models/KnowledgeChunk.js";
import { KnowledgeSourceModel } from "../src/models/KnowledgeSource.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import {
  chunkKnowledgeText,
  createKnowledgeSource,
  disableKnowledgeSource,
  embedKnowledgeTexts,
  searchKnowledge,
} from "../src/services/knowledgeService.js";

const ownerId = `knowledge-smoke-${Date.now()}`;

await connectDatabase();

try {
  const longText = Array.from({ length: 80 }, (_, index) =>
    `Section ${index + 1}. This paragraph verifies stable semantic chunking while preserving useful context for retrieval.`,
  ).join("\n\n");
  const chunks = chunkKnowledgeText(longText);
  if (chunks.length < 2 || chunks.some((chunk) => chunk.length > 3_100)) {
    throw new Error("Knowledge chunking did not produce bounded overlapping chunks.");
  }

  const agent = await VoiceAgentModel.create({
    ownerId,
    name: "Knowledge smoke agent",
    team: "Quality",
    prompt: "Answer using approved knowledge.",
    firstMessage: "Hello.",
  });
  const source = await createKnowledgeSource({
    ownerId,
    agentId: agent._id,
    name: "Warranty operations",
    sourceType: "text",
    content: "The orbital return code for warranty replacements is QUARTZ-7319. Use it only for approved replacement shipments.",
  });
  if (source.status !== "ready" || source.chunkCount < 1) {
    throw new Error("Knowledge source was not indexed.");
  }

  const vectorQuery = "What is the orbital return code for a warranty replacement?";
  const [queryVector] = await embedKnowledgeTexts([vectorQuery], "RETRIEVAL_QUERY");
  let vectorMatches: { content: string }[] = [];
  for (let attempt = 0; attempt < 15 && !vectorMatches.length; attempt += 1) {
    vectorMatches = await KnowledgeChunkModel.aggregate<{ content: string }>([
      {
        $vectorSearch: {
          index: env.knowledgeVectorIndex,
          path: "embedding",
          queryVector,
          numCandidates: 50,
          limit: 3,
          filter: { ownerId, agentId: agent._id, embeddingModel: source.embeddingModel },
        },
      },
      { $project: { _id: 0, content: 1 } },
    ]);
    if (!vectorMatches.length) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!vectorMatches.some((match) => match.content.includes("QUARTZ-7319"))) {
    throw new Error("MongoDB Atlas Vector Search did not return the expected source.");
  }

  const results = await searchKnowledge({
    ownerId,
    agentId: agent._id,
    query: vectorQuery,
  });
  if (!results[0]?.content.includes("QUARTZ-7319")) {
    throw new Error("Semantic retrieval did not return the expected source.");
  }

  await disableKnowledgeSource(source);
  const disabledResults = await searchKnowledge({
    ownerId,
    agentId: agent._id,
    query: "What is the orbital return code?",
  });
  if (disabledResults.length) throw new Error("Disabled knowledge was still searchable.");

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "bounded semantic chunking",
      "embedding generation",
      "knowledge source indexing",
      "MongoDB Atlas Vector Search",
      "semantic retrieval service",
      "disabled-source exclusion",
    ],
  }));
} finally {
  await Promise.all([
    KnowledgeChunkModel.deleteMany({ ownerId }),
    KnowledgeSourceModel.deleteMany({ ownerId }),
    VoiceAgentModel.deleteMany({ ownerId }),
  ]);
  await mongoose.disconnect();
}
