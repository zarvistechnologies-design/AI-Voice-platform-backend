import { Schema, model, type InferSchemaType } from "mongoose";

const agentCampaignSlotSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    slot: { type: Number, required: true, min: 0 },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    campaignLeadId: { type: Schema.Types.ObjectId, ref: "CampaignLead", required: true },
    leaseToken: { type: String, required: true, trim: true },
    leasedUntil: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

agentCampaignSlotSchema.index({ agentId: 1, slot: 1 }, { unique: true });
agentCampaignSlotSchema.index({ campaignLeadId: 1 }, { unique: true });

export type AgentCampaignSlot = InferSchemaType<typeof agentCampaignSlotSchema>;
export const AgentCampaignSlotModel = model<AgentCampaignSlot>("AgentCampaignSlot", agentCampaignSlotSchema);
