import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import { AgentCampaignSlotModel } from "../models/AgentCampaignSlot.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { AuthSessionModel } from "../models/AuthSession.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignModel } from "../models/Campaign.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { EmailDeliveryModel } from "../models/EmailDelivery.js";
import { KnowledgeChunkModel } from "../models/KnowledgeChunk.js";
import { KnowledgeSourceModel } from "../models/KnowledgeSource.js";
import { OrganizationModel } from "../models/Organization.js";
import { OrganizationInvitationModel } from "../models/OrganizationInvitation.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { PhoneNumberReservationModel } from "../models/PhoneNumberReservation.js";
import { PhoneNumberCallAdmissionModel } from "../models/PhoneNumberCallAdmission.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { UserModel } from "../models/User.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";
import { WebhookEndpointModel } from "../models/WebhookEndpoint.js";

const models = [
  ApiKeyModel,
  AgentCampaignSlotModel,
  AuditLogModel,
  AuthSessionModel,
  BillingInvoiceModel,
  BillingSubscriptionModel,
  BillingTransactionModel,
  CallDetailRecordModel,
  CampaignModel,
  CampaignLeadModel,
  ContactSuppressionModel,
  CreditWalletModel,
  EmailDeliveryModel,
  KnowledgeChunkModel,
  KnowledgeSourceModel,
  OrganizationModel,
  OrganizationInvitationModel,
  OrganizationMemberModel,
  PhoneNumberModel,
  PhoneNumberReservationModel,
  PhoneNumberCallAdmissionModel,
  ProviderIntegrationModel,
  UserModel,
  VoiceAgentModel,
  WebhookDeliveryModel,
  WebhookEndpointModel,
] as const;

await connectDatabase();

try {
  for (const model of models) {
    // createIndexes only adds declared indexes; it does not drop existing ones.
    await model.createIndexes();
    const indexes = await model.collection.indexes();
    console.log(JSON.stringify({
      collection: model.collection.collectionName,
      indexes: indexes.map((index) => index.name),
    }));
  }
} finally {
  await mongoose.disconnect();
}
