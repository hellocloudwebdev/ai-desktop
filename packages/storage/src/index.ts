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

// PR32: Extension metadata and project bindings persistence
export type {
  ExtensionRepository,
  StoredExtension,
  CreateExtensionData,
} from "./extensions/extension-repository.js";
export { PrismaExtensionRepository } from "./extensions/prisma-extension-repository.js";
export type {
  ExtensionProjectBindingRepository,
  StoredExtensionProjectBinding,
} from "./extensions/extension-project-binding-repository.js";
export { PrismaExtensionProjectBindingRepository } from "./extensions/prisma-extension-project-binding-repository.js";

// PR28: Scoped import_guard facts persistence
export type {
  MemoryRepository,
  StoredMemoryFact,
  CreateMemoryFactData,
  ListMemoryFactsQuery,
} from "./memory/memory-repository.js";
export { PrismaMemoryRepository } from "./memory/prisma-memory-repository.js";

// PR37: Document metadata and chunk persistence
export type {
  DocumentRepository,
  StoredDocument,
  StoredDocumentChunk,
  CreateDocumentData,
  CreateDocumentChunkData,
  UpdateDocumentStatusData,
} from "./documents/document-repository.js";
export { PrismaDocumentRepository } from "./documents/prisma-document-repository.js";

// PR39: Attachment metadata persistence (bytes stay in MediaArtifactStore)
export type {
  AttachmentRepository,
  StoredAttachment,
  CreateAttachmentData,
} from "./attachments/attachment-repository.js";
export { PrismaAttachmentRepository } from "./attachments/prisma-attachment-repository.js";

// PR43: Durable background-task persistence (repository only, no execution logic)
export type {
  BackgroundTaskRow,
  BackgroundTaskStatusPatch,
} from "./background/background-task-repository.js";
export {
  PrismaBackgroundTaskRepository,
  BackgroundTaskValidationError,
  BackgroundTaskSecretError,
} from "./background/background-task-repository.js";

// PR44: Durable scheduled-task persistence (repository only, no execution logic)
export type {
  ScheduledTaskRow,
  ScheduledRunRow,
  ScheduledRunPatch,
} from "./scheduling/scheduled-task-repository.js";
export {
  PrismaScheduledTaskRepository,
  PrismaScheduledRunRepository,
  ScheduledTaskValidationError,
  ScheduledTaskSecretError,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_PROMPT_LENGTH,
  MAX_SCHEDULE_DESCRIPTION_LENGTH,
  MAX_SCHEDULE_CONFIG_LENGTH,
  MAX_SCHEDULE_ERROR_LENGTH,
} from "./scheduling/scheduled-task-repository.js";
