import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { KnowledgeChunkModel } from "../src/models/KnowledgeChunk.js";

await connectDatabase();

try {
  const definition = {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: env.knowledgeEmbeddingDimensions,
        similarity: "cosine",
      },
      { type: "filter", path: "ownerId" },
      { type: "filter", path: "agentId" },
      { type: "filter", path: "embeddingModel" },
    ],
  };
  const indexes = await KnowledgeChunkModel.listSearchIndexes();
  let action: "created" | "updated";
  if (indexes.some((index) => index.name === env.knowledgeVectorIndex)) {
    await KnowledgeChunkModel.updateSearchIndex(env.knowledgeVectorIndex, definition);
    action = "updated";
  } else {
    await KnowledgeChunkModel.createSearchIndex({
      name: env.knowledgeVectorIndex,
      type: "vectorSearch",
      definition,
    });
    action = "created";
  }
  const current = (await KnowledgeChunkModel.listSearchIndexes() as Array<{
    name: string;
    status?: string;
    queryable?: boolean;
  }>).find((index) => index.name === env.knowledgeVectorIndex);
  console.log(JSON.stringify({
    action,
    index: env.knowledgeVectorIndex,
    status: current?.status ?? "provisioning",
    queryable: current?.queryable ?? false,
  }));
} finally {
  await mongoose.disconnect();
}
