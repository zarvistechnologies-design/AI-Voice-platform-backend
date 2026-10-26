import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

import { AssistantConversationModel } from "../src/models/AssistantConversation.js";
import {
  deleteAssistantConversation, getAssistantConversation, saveAssistantReply,
} from "../src/services/assistantConversationService.js";
import { HttpError } from "../src/utils/httpError.js";

test("Ask Vozon chat history stays scoped to its workspace and user", async () => {
  const model = AssistantConversationModel as unknown as {
    findOne: (query: Record<string, unknown>) => { lean: () => Promise<any> };
    updateOne: (query: Record<string, unknown>, update: Record<string, any>) => Promise<any>;
    deleteOne: (query: Record<string, unknown>) => Promise<any>;
  };
  const previousFind = model.findOne;
  const previousUpdate = model.updateOne;
  const previousDelete = model.deleteOne;
  const id = new Types.ObjectId().toString();
  const ownerId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const stored = {
    _id: id, title: "First question", updatedAt: new Date(),
    messages: [{ role: "user", content: "First question" }, { role: "assistant", content: "First answer" }],
  };
  let updatedMessages: Array<{ role: string; content: string }> = [];
  let deleted = false;
  try {
    model.findOne = (query) => ({ lean: async () =>
      query.ownerId === ownerId && query.userId === userId ? stored : null });
    model.updateOne = async (query, update) => {
      assert.equal(query.ownerId, ownerId);
      assert.equal(query.userId, userId);
      updatedMessages = update.$push.messages.$each;
      return { matchedCount: 1 };
    };
    model.deleteOne = async (query) => {
      assert.equal(query.ownerId, ownerId);
      assert.equal(query.userId, userId);
      deleted = true;
      return { deletedCount: 1 };
    };

    const history = await getAssistantConversation(ownerId, userId, id);
    assert.equal(history.messages.length, 2);
    await assert.rejects(() => getAssistantConversation(ownerId, "other-user", id),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404);
    await saveAssistantReply(ownerId, userId, id, [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ], { answer: "Second answer" });
    assert.deepEqual(updatedMessages.map(({ content }) => content), ["Second question", "Second answer"]);
    await deleteAssistantConversation(ownerId, userId, id);
    assert.equal(deleted, true);
  } finally {
    model.findOne = previousFind;
    model.updateOne = previousUpdate;
    model.deleteOne = previousDelete;
  }
});
