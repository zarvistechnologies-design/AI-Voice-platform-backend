import { Schema, model, type InferSchemaType } from "mongoose";

const workflowNodeSchema = new Schema(
  {
    nodeId: { type: String, required: true, trim: true, maxlength: 120 },
    type: {
      type: String,
      enum: ["trigger", "agent", "condition", "tool", "action", "handoff", "wait", "end"],
      required: true,
    },
    position: {
      x: { type: Number, required: true, default: 0 },
      y: { type: Number, required: true, default: 0 },
    },
    data: {
      label: { type: String, required: true, trim: true, maxlength: 120 },
      description: { type: String, trim: true, maxlength: 1000, default: "" },
      config: { type: Schema.Types.Mixed, default: {} },
    },
  },
  { _id: false },
);

const workflowEdgeSchema = new Schema(
  {
    edgeId: { type: String, required: true, trim: true, maxlength: 120 },
    source: { type: String, required: true, trim: true, maxlength: 120 },
    target: { type: String, required: true, trim: true, maxlength: 120 },
    sourceHandle: { type: String, trim: true, maxlength: 80, default: "" },
    targetHandle: { type: String, trim: true, maxlength: 80, default: "" },
    label: { type: String, trim: true, maxlength: 120, default: "" },
  },
  { _id: false },
);

const workflowRunSchema = new Schema(
  {
    runId: { type: String, required: true },
    status: { type: String, enum: ["completed", "failed"], required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
    input: { type: Schema.Types.Mixed, default: {} },
    timeline: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const agentWorkflowSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    status: { type: String, enum: ["draft", "live", "paused"], default: "draft", index: true },
    version: { type: Number, min: 1, default: 1 },
    publishedVersion: { type: Number, min: 0, default: 0 },
    nodes: { type: [workflowNodeSchema], default: [] },
    edges: { type: [workflowEdgeSchema], default: [] },
    variables: { type: Schema.Types.Mixed, default: {} },
    lastPublishedAt: { type: Date, default: null },
    runs: { type: [workflowRunSchema], default: [] },
  },
  { timestamps: true },
);

agentWorkflowSchema.index({ ownerId: 1, updatedAt: -1 });

export type AgentWorkflow = InferSchemaType<typeof agentWorkflowSchema>;
export const AgentWorkflowModel = model<AgentWorkflow>("AgentWorkflow", agentWorkflowSchema);
