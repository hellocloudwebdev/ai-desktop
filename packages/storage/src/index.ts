// PR8: packages/storage — Public API Surface
//
// Clean storage abstractions. PrismaClient and internal database queries
// strictly remain behind this package boundary.

export type { DatabaseOptions } from "./client/database.js";
export { StorageDatabase } from "./client/database.js";

export type { EventRepository } from "./events/event-repository.js";
export {
  PrismaEventRepository,
  StorageError,
  DuplicateSequenceError,
} from "./events/prisma-event-repository.js";

// PR9: Secrets abstraction & OS keychain implementation
export * from "./secrets/index.js";

// PR22: Provider profile persistence
export type {
  ProviderProfileRepository,
  StoredProviderProfile,
  CreateProfileData,
  UpdateProfileData,
} from "./profiles/profile-repository.js";
export { PrismaProviderProfileRepository } from "./profiles/prisma-profile-repository.js";

// PR22: Conversation model selection persistence
export type {
  ConversationModelRepository,
  StoredConversationModel,
  SetConversationModelData,
} from "./conversations/conversation-model-repository.js";
export { PrismaConversationModelRepository } from "./conversations/prisma-conversation-model-repository.js";

// PR24: Permission policies and audit persistence
export type {
  PermissionRepository,
  StoredPermissionPolicy,
  CreatePolicyData,
  FindPoliciesQuery,
  StoredPermissionAudit,
  RecordAuditData,
  FindAuditQuery,
} from "./permissions/permission-repository.js";
export { PrismaPermissionRepository } from "./permissions/prisma-permission-repository.js";

// PR26: Skill metadata and enablement persistence
export type { SkillRepository, StoredSkill, CreateSkillData } from "./skills/skill-repository.js";
export { PrismaSkillRepository } from "./skills/prisma-skill-repository.js";
