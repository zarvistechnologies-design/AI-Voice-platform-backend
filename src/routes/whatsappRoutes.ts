import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  requireWhiteLabelFeature,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";
import {
  listWhatsAppTemplates,
  createWhatsAppTemplate,
  syncWhatsAppTemplates,
  deleteWhatsAppTemplate,
  listWhatsAppContactGroups,
  createWhatsAppContactGroup,
  deleteWhatsAppContactGroup,
  listWhatsAppContacts,
  createWhatsAppContact,
  importWhatsAppContacts,
  deleteWhatsAppContact,
  listWhatsAppCampaigns,
  createWhatsAppCampaign,
  deleteWhatsAppCampaign,
  getWhatsAppAgentConfig,
  updateWhatsAppAgentConfig,
  listWhatsAppCustomAgents,
  createWhatsAppCustomAgent,
  updateWhatsAppCustomAgent,
  deleteWhatsAppCustomAgent,
  simulateWhatsAppCustomAgent,
  listWhatsAppConversations,
  getWhatsAppMessages,
  sendWhatsAppChatMessage,
  toggleWhatsAppConversationMode,
  triggerWhatsAppConversationIntegration,
  callWhatsAppConversationContact,
  listWhatsAppConversationCases,
  createWhatsAppConversationCase,
  updateWhatsAppSupportCaseStatus,
  listWhatsAppForms,
  createWhatsAppForm,
  getWhatsAppFormSubmissions,
  listWhatsAppFlows,
  saveWhatsAppFlow,
  deleteWhatsAppFlow,
} from "../controllers/whatsappFeatureController.js";

export const whatsappRouter = Router();

whatsappRouter.use(requireAuth);
whatsappRouter.use(requireWhiteLabelSubscription, requireWhiteLabelFeature("integrations"));

// 1. Templates
whatsappRouter.get("/templates", asyncHandler(listWhatsAppTemplates));
whatsappRouter.post("/templates", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppTemplate));
whatsappRouter.post("/templates/sync", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(syncWhatsAppTemplates));
whatsappRouter.delete("/templates/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppTemplate));

// 2. Contact Groups & Contacts
whatsappRouter.get("/contact-groups", asyncHandler(listWhatsAppContactGroups));
whatsappRouter.post("/contact-groups", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppContactGroup));
whatsappRouter.delete("/contact-groups/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppContactGroup));

whatsappRouter.get("/contacts", asyncHandler(listWhatsAppContacts));
whatsappRouter.post("/contacts", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppContact));
whatsappRouter.post("/contacts/import", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(importWhatsAppContacts));
whatsappRouter.delete("/contacts/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppContact));

// 3. Campaigns
whatsappRouter.get("/campaigns", asyncHandler(listWhatsAppCampaigns));
whatsappRouter.post("/campaigns", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppCampaign));
whatsappRouter.delete("/campaigns/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppCampaign));

// 4. Agents (Workspace Guardrails + Multi-Agent Custom WhatsApp AI Studio)
whatsappRouter.get("/agents", asyncHandler(getWhatsAppAgentConfig));
whatsappRouter.put("/agents", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(updateWhatsAppAgentConfig));
whatsappRouter.get("/agents/list", asyncHandler(listWhatsAppCustomAgents));
whatsappRouter.post("/agents/list", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppCustomAgent));
whatsappRouter.put("/agents/list/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(updateWhatsAppCustomAgent));
whatsappRouter.delete("/agents/list/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppCustomAgent));
whatsappRouter.post("/agents/list/:id/simulate", asyncHandler(simulateWhatsAppCustomAgent));

// 5. Live Chat
whatsappRouter.get("/conversations", asyncHandler(listWhatsAppConversations));
whatsappRouter.get("/conversations/:conversationId/messages", asyncHandler(getWhatsAppMessages));
whatsappRouter.post("/conversations/:conversationId/messages", requireWhiteLabelWriteAccess, asyncHandler(sendWhatsAppChatMessage));
whatsappRouter.put("/conversations/:conversationId/mode", requireWhiteLabelWriteAccess, asyncHandler(toggleWhatsAppConversationMode));
whatsappRouter.post("/conversations/:conversationId/integration-action", requireWhiteLabelWriteAccess, asyncHandler(triggerWhatsAppConversationIntegration));
whatsappRouter.post("/conversations/:conversationId/call", requireWhiteLabelWriteAccess, asyncHandler(callWhatsAppConversationContact));
whatsappRouter.get("/conversations/:conversationId/cases", asyncHandler(listWhatsAppConversationCases));
whatsappRouter.post("/conversations/:conversationId/cases", requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppConversationCase));
whatsappRouter.patch("/cases/:caseId", requireWhiteLabelWriteAccess, asyncHandler(updateWhatsAppSupportCaseStatus));

// 6. Meta Forms
whatsappRouter.get("/forms", asyncHandler(listWhatsAppForms));
whatsappRouter.post("/forms", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(createWhatsAppForm));
whatsappRouter.get("/forms/:formId/submissions", asyncHandler(getWhatsAppFormSubmissions));

// 7. Flow Maker
whatsappRouter.get("/flows", asyncHandler(listWhatsAppFlows));
whatsappRouter.post("/flows", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(saveWhatsAppFlow));
whatsappRouter.delete("/flows/:id", requireRole("owner", "admin"), requireWhiteLabelWriteAccess, asyncHandler(deleteWhatsAppFlow));

