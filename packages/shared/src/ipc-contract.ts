// PR3: packages/shared — IPC Contract Specification
//
// Establishes the typed contract between renderer, preload, and main processes.
//
// Constitutional Rule:
//   - shared ↑ desktop / preload / renderer
//   - shared NEVER imports Electron or DOM APIs.
//   - The actual handlers, invokers, and streaming listeners reside in apps/desktop.
//   - Zod schemas provide runtime validation at process boundaries.

import { z } from "zod";
import type {
  BrowserPageId,
  BrowserSessionId,
  ConversationId,
  MessageId,
  PermissionRequestId,
  ResearchDocumentId,
  ResearchRequestId,
  ResearchResultId,
  ResearchSourceId,
  TaskId,
  ToolCallId,
} from "./ids.js";
import type { Timestamp } from "./time.js";
import { type Result, ok, err } from "./result.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Canonical Channel Names
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  // Chat & streaming operations
  CHAT_SEND: "chat:send",
  CHAT_CANCEL: "chat:cancel",
  CHAT_SUBSCRIBE: "chat:subscribe",
  CHAT_UNSUBSCRIBE: "chat:unsubscribe",
  CHAT_STREAM_EVENT: "chat:stream-event",
  CHAT_STREAM_BATCH: "chat:stream-batch",
  CONVERSATION_LOAD: "conversation:load",

  // Application lifecycle & health
  APP_HEALTH_CHECK: "app:health-check",
  APP_GET_VERSION: "app:get-version",

  // Provider profile & model operations (PR22)
  PROVIDER_PROFILES_LIST: "provider:profiles-list",
  PROVIDER_PROFILE_CREATE: "provider:profile-create",
  PROVIDER_PROFILE_UPDATE: "provider:profile-update",
  PROVIDER_PROFILE_DELETE: "provider:profile-delete",
  PROVIDER_MODELS_LIST: "provider:models-list",
  CONVERSATION_MODEL_SET: "conversation:model-set",
  CONVERSATION_MODEL_GET: "conversation:model-get",

  // Permission operations (PR24)
  PERMISSION_CHECK: "permission:check",
  PERMISSION_REQUESTS_LIST: "permission:requests-list",
  PERMISSION_RESOLVE: "permission:resolve",
  PERMISSION_REVOKE: "permission:revoke",
  PERMISSION_POLICIES_LIST: "permission:policies-list",

  // Skill operations (PR26)
  SKILLS_LIST: "skills:list",
  SKILLS_INSTALL: "skills:install",
  SKILLS_UNINSTALL: "skills:uninstall",
  SKILLS_ENABLE: "skills:enable",
  SKILLS_DISABLE: "skills:disable",
  SKILLS_GET: "skills:get",
  SKILLS_REFERENCES_LOAD: "skills:references-load",

  // Memory operations (PR28)
  MEMORY_LIST: "memory:list",
  MEMORY_GET: "memory:get",
  MEMORY_UPDATE: "memory:update",
  MEMORY_DELETE: "memory:delete",
  MEMORY_SEARCH: "memory:search",
  MEMORY_SUPERSEDE: "memory:supersede",

  // Agent runtime operations (PR29)
  AGENT_START: "agent:start",
  AGENT_CANCEL: "agent:cancel",
  AGENT_GET: "agent:get",
  AGENT_LIST: "agent:list",

  // Coding agent operations (PR30)
  CODING_START: "coding:start",
  CODING_CANCEL: "coding:cancel",
  CODING_GET: "coding:get",
  CODING_LIST: "coding:list",

  // Extension operations (PR32)
  EXTENSION_LIST: "extension:list",
  EXTENSION_GET: "extension:get",
  EXTENSION_INSTALL: "extension:install",
  EXTENSION_UNINSTALL: "extension:uninstall",
  EXTENSION_ENABLE: "extension:enable",
  EXTENSION_DISABLE: "extension:disable",
  EXTENSION_PROJECT_ENABLE: "extension:project-enable",
  EXTENSION_PROJECT_DISABLE: "extension:project-disable",

  // Rich surface operations (PR33). NOTE: there is intentionally NO
  // surface:execute channel — surface actions route through the agent tool
  // router (existing ToolExecutor lifecycle), never through IPC execution.
  SURFACE_LIST: "surface:list",
  SURFACE_GET: "surface:get",
  SURFACE_ACTION: "surface:action",
  SURFACE_DISPOSE: "surface:dispose",

  // Browser automation operations (PR34.5). NOTE: there is intentionally
  // NO browser:execute channel (arbitrary execution via IPC is disallowed;
  // actions route via agent tool router).
  BROWSER_SESSION_CREATE: "browser:session-create",
  BROWSER_SESSION_GET: "browser:session-get",
  BROWSER_SESSION_CLOSE: "browser:session-close",
  BROWSER_PAGE_OPEN: "browser:page-open",
  BROWSER_PAGE_LIST: "browser:page-list",
  BROWSER_PAGE_GET: "browser:page-get",
  BROWSER_PAGE_CLOSE: "browser:page-close",
  BROWSER_SCREENSHOT: "browser:screenshot",

  // Web research operations (PR35). NOTE: there is intentionally NO
  // research:execute channel — operations flow through the agent tool router
  // (ResearchToolExecutor), never arbitrary IPC.
  RESEARCH_SEARCH: "research:search",
  RESEARCH_OPEN: "research:open",
  RESEARCH_STATUS: "research:status",

  // Project document operations (PR37). NOTE: there is intentionally NO
  // documents:execute / documents:read-path / documents:raw-fs channel —
  // operations flow through the agent tool router (DocumentsToolExecutor)
  // or the narrow typed handlers below; the renderer never receives
  // filesystem primitives.
  DOCUMENTS_LIST: "documents:list",
  DOCUMENTS_GET: "documents:get",
  DOCUMENTS_SEARCH: "documents:search",
  DOCUMENTS_INGEST: "documents:ingest",
  DOCUMENTS_DELETE: "documents:delete",

  // Project attachment operations (PR39). NOTE: there is intentionally NO
  // attachments:read-path / attachments:execute / media:readPath channel —
  // bytes live in the main-process MediaArtifactStore; the renderer receives
  // metadata plus a bounded image-only thumbnail preview (max 200KB).
  // Audio/video previews return a metadata card without bytes.
  ATTACHMENTS_LIST: "attachments:list",
  ATTACHMENTS_GET: "attachments:get",
  ATTACHMENTS_UPLOAD: "attachments:upload",
  ATTACHMENTS_DELETE: "attachments:delete",
  ATTACHMENTS_PREVIEW: "attachments:preview",

  // MCP server operations (PR38). NOTE: there is intentionally NO
  // mcp:execute channel — tool execution flows through the agent tool
  // router (McpToolExecutor), never arbitrary IPC.
  MCP_SERVER_LIST: "mcp:listServers",
  MCP_SERVER_GET: "mcp:getServer",
  MCP_SERVER_CONNECT: "mcp:connect",
  MCP_SERVER_DISCONNECT: "mcp:disconnect",
  MCP_CAPABILITIES: "mcp:listCapabilities",
  MCP_RESOURCES: "mcp:listResources",
  MCP_RESOURCE_READ: "mcp:readResource",
  MCP_PROMPTS: "mcp:listPrompts",
  MCP_PROMPT_GET: "mcp:getPrompt",
  MCP_SUBSCRIBE: "mcp:subscribe",
  MCP_UNSUBSCRIBE: "mcp:unsubscribe",

  // Realtime voice operations (PR40). NOTE: there is intentionally NO
  // realtime:execute / voice:execute / audio:execute channel — audio flows
  // as bounded typed commands; execution flows through the agent tool
  // router. Microphone handles and provider sessions never cross IPC.
  REALTIME_CAPABILITIES: "realtime:capabilities",
  REALTIME_SESSION_CREATE: "realtime:session:create",
  REALTIME_SESSION_START: "realtime:session:start",
  REALTIME_SESSION_INTERRUPT: "realtime:session:interrupt",
  REALTIME_SESSION_STOP: "realtime:session:stop",
  REALTIME_SESSION_GET: "realtime:session:get",
  REALTIME_SESSION_LIST: "realtime:session:list",
  REALTIME_TRANSCRIPT: "realtime:transcript",
  REALTIME_AUDIO: "realtime:audio",

  // Desktop workspace operations (PR41). NOTE: there is intentionally NO
  // workspace:execute / filesystem:execute / shell:execute / node:execute
  // channel — execution flows through the agent tool router
  // (CodingToolExecutor with PermissionManager mediation), never through
  // raw IPC.
  WORKSPACE_FILES_LIST: "workspace:files:list",
  WORKSPACE_FILES_READ: "workspace:files:read",
  WORKSPACE_FILES_WRITE: "workspace:files:write",
  WORKSPACE_FILES_CREATE: "workspace:files:create",
  WORKSPACE_FILES_RENAME: "workspace:files:rename",
  WORKSPACE_FILES_DELETE: "workspace:files:delete",
  WORKSPACE_SEARCH: "workspace:search",
  WORKSPACE_DIAGNOSTICS_REPORT: "workspace:diagnostics:report",
  WORKSPACE_DIAGNOSTICS_LIST: "workspace:diagnostics:list",
  WORKSPACE_DIAGNOSTICS_CLEAR: "workspace:diagnostics:clear",
  TERMINAL_LIST: "terminal:list",
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_STOP: "terminal:stop",
  TERMINAL_OUTPUT: "terminal:output",

  // Git operations (PR42). NOTE: there is intentionally NO
  // git:execute channel — execution flows through the agent tool router
  // (GitToolExecutor with PermissionManager mediation), never through
  // raw IPC.
  GIT_DETECT: "git:detect",
  GIT_STATUS: "git:status",
  GIT_DIFF: "git:diff",
  GIT_LOG: "git:log",
  GIT_BRANCHES: "git:branches",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_COMMIT: "git:commit",

  // Background task operations (PR43). NOTE: there is intentionally NO
  // background:execute / background-tasks:execute channel — execution flows
  // through the agent tool router (existing AgentService path with
  // PermissionManager mediation), never through arbitrary IPC.
  BACKGROUND_TASKS_LIST: "background-tasks:list",
  BACKGROUND_TASKS_GET: "background-tasks:get",
  BACKGROUND_TASKS_START: "background-tasks:start",
  BACKGROUND_TASKS_PAUSE: "background-tasks:pause",
  BACKGROUND_TASKS_RESUME: "background-tasks:resume",
  BACKGROUND_TASKS_CANCEL: "background-tasks:cancel",
  BACKGROUND_TASKS_RESPOND: "background-tasks:respond",

  // Scheduled task operations (PR44). NOTE: there is intentionally NO
  // schedules:execute channel — execution flows through the agent tool
  // router (DesktopBackgroundTaskService path with PermissionManager
  // mediation), never through arbitrary IPC.
  SCHEDULES_LIST: "schedules:list",
  SCHEDULES_GET: "schedules:get",
  SCHEDULES_CREATE: "schedules:create",
  SCHEDULES_UPDATE: "schedules:update",
  SCHEDULES_ENABLE: "schedules:enable",
  SCHEDULES_DISABLE: "schedules:disable",
  SCHEDULES_DELETE: "schedules:delete",
  SCHEDULES_RUN_NOW: "schedules:run-now",
  SCHEDULES_RUNS: "schedules:runs",

  // Account operations (PR45). NOTE: there is intentionally NO
  // account:execute channel — authentication never crosses IPC with
  // credentials; sign-in carries displayName/email identity only, refresh
  // tokens live exclusively in the OS SecretStore main-side.
  ACCOUNT_GET: "account:get",
  ACCOUNT_SIGN_IN: "account:sign-in",
  ACCOUNT_SIGN_OUT: "account:sign-out",
  ACCOUNT_REFRESH: "account:refresh",
  ACCOUNT_DEVICE: "account:device",

  // Cross-device sync operations (PR45). NOTE: there is intentionally NO
  // sync:execute channel — sync flows through the main-process SyncService
  // with bounded validation, never arbitrary IPC execution.
  SYNC_STATUS: "sync:status",
  SYNC_START: "sync:start",
  SYNC_PAUSE: "sync:pause",
  SYNC_CONFLICTS: "sync:conflicts",
  SYNC_RESOLVE: "sync:resolve",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ---------------------------------------------------------------------------
// Base Field Schemas
// ---------------------------------------------------------------------------

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const UlidStringSchema = z
  .string()
  .trim()
  .regex(ULID_PATTERN, { message: "Value must be a valid 26-character Crockford Base32 ULID" });

export const TimestampStringSchema = z.string().trim().regex(ISO_UTC_PATTERN, {
  message: "Timestamp must be an ISO-8601 UTC string (YYYY-MM-DDTHH:mm:ss.sssZ)",
});

export const ConversationIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ConversationId,
);
export const MessageIdSchema = UlidStringSchema.transform((val) => val.toUpperCase() as MessageId);
export const TaskIdSchema = UlidStringSchema.transform((val) => val.toUpperCase() as TaskId);
export const PermissionRequestIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as PermissionRequestId,
);
export const ToolCallIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ToolCallId,
);
export const BrowserSessionIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as BrowserSessionId,
);
export const BrowserPageIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as BrowserPageId,
);
export const ResearchRequestIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ResearchRequestId,
);
export const ResearchSourceIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ResearchSourceId,
);
export const ResearchResultIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ResearchResultId,
);
export const ResearchDocumentIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ResearchDocumentId,
);

// ---------------------------------------------------------------------------
// Command Contracts (Renderer -> Main Process)
// ---------------------------------------------------------------------------

/**
 * Command to send a user message and initiate/continue a conversation stream.
 */
export const ChatSendCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  content: z.string().min(1, "Message content cannot be empty"),
  clientMessageId: MessageIdSchema.optional(),
  modelId: z.string().min(1).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: TimestampStringSchema.optional(),
});

export type ChatSendCommand = z.infer<typeof ChatSendCommandSchema>;

/**
 * Command to load a persisted conversation and its messages.
 */
export const ConversationLoadCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ConversationLoadCommand = z.infer<typeof ConversationLoadCommandSchema>;

/**
 * Command to cancel an active streaming operation or task.
 */
export const ChatCancelCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  messageId: MessageIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  reason: z.string().max(500).optional(),
});

export type ChatCancelCommand = z.infer<typeof ChatCancelCommandSchema>;

/**
 * Command to subscribe to streaming events for a specific conversation.
 */
export const ChatSubscribeCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ChatSubscribeCommand = z.infer<typeof ChatSubscribeCommandSchema>;

/**
 * Command to unsubscribe from streaming events for a specific conversation.
 */
export const ChatUnsubscribeCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ChatUnsubscribeCommand = z.infer<typeof ChatUnsubscribeCommandSchema>;

/**
 * Command to list all saved provider profiles (PR22).
 */
export const ProviderProfilesListCommandSchema = z.object({}).optional().default({});

export type ProviderProfilesListCommand = z.infer<typeof ProviderProfilesListCommandSchema>;

/**
 * Command to create a new provider profile (PR22).
 */
export const ProviderProfileCreateCommandSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  credentialRef: z.string().trim().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  organizationId: z.string().trim().min(1).optional(),
  defaultModelId: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().default(true),
});

export type ProviderProfileCreateCommand = z.infer<typeof ProviderProfileCreateCommandSchema>;

/**
 * Command to update an existing provider profile (PR22).
 */
export const ProviderProfileUpdateCommandSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  credentialRef: z.string().trim().min(1).nullable().optional(),
  endpointUrl: z.string().url().nullable().optional(),
  organizationId: z.string().trim().min(1).nullable().optional(),
  defaultModelId: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
});

export type ProviderProfileUpdateCommand = z.infer<typeof ProviderProfileUpdateCommandSchema>;

/**
 * Command to delete a provider profile (PR22).
 */
export const ProviderProfileDeleteCommandSchema = z.object({
  id: z.string().trim().min(1),
});

export type ProviderProfileDeleteCommand = z.infer<typeof ProviderProfileDeleteCommandSchema>;

/**
 * Command to list all available models across registered providers (PR22).
 */
export const ProviderModelsListCommandSchema = z.object({}).optional().default({});

export type ProviderModelsListCommand = z.infer<typeof ProviderModelsListCommandSchema>;

/**
 * Command to set the provider/model selection for a conversation (PR22).
 */
export const ConversationModelSetCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  providerId: z.string().trim().min(1).max(64),
  modelId: z.string().trim().min(1).max(64),
  profileId: z.string().trim().min(1).optional(),
});

export type ConversationModelSetCommand = z.infer<typeof ConversationModelSetCommandSchema>;

/**
 * Command to get the persisted provider/model selection for a conversation (PR22).
 */
export const ConversationModelGetCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ConversationModelGetCommand = z.infer<typeof ConversationModelGetCommandSchema>;

/**
 * Command to check a capability permission (PR24).
 */
export const PermissionCheckCommandSchema = z.object({
  capability: z.string().trim().min(1),
  action: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  scope: z.enum(["once", "session", "workspace", "project", "always"]).default("once"),
  risk: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  relatedToolCallIds: z.array(ToolCallIdSchema).min(1),
  projectId: z.string().trim().min(1).optional(),
  conversationId: ConversationIdSchema.optional(),
  batchId: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
});

export type PermissionCheckCommand = z.infer<typeof PermissionCheckCommandSchema>;

/**
 * Command to list pending permission requests awaiting user approval (PR24).
 */
export const PermissionRequestsListCommandSchema = z.object({}).optional().default({});

export type PermissionRequestsListCommand = z.infer<typeof PermissionRequestsListCommandSchema>;

/**
 * Command to resolve an outstanding permission request (PR24).
 */
export const PermissionResolveCommandSchema = z.object({
  requestId: PermissionRequestIdSchema,
  decision: z.enum(["granted", "denied"]),
  mode: z.enum(["allow_once", "allow_session", "allow_project", "deny"]),
  reason: z.string().max(500).optional(),
});

export type PermissionResolveCommand = z.infer<typeof PermissionResolveCommandSchema>;

/**
 * Command to revoke permission policies (PR24).
 */
export const PermissionRevokeCommandSchema = z.object({
  capability: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  resourcePattern: z.string().trim().min(1).optional(),
  scope: z.enum(["session", "project"]).optional(),
});

export type PermissionRevokeCommand = z.infer<typeof PermissionRevokeCommandSchema>;

/**
 * Command to list active permission policies (PR24).
 */
export const PermissionPoliciesListCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
  })
  .optional()
  .default({});

export type PermissionPoliciesListCommand = z.infer<typeof PermissionPoliciesListCommandSchema>;

/**
 * Command to list skills (PR26).
 */
export const SkillsListCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
  })
  .optional()
  .default({});

export type SkillsListCommand = z.infer<typeof SkillsListCommandSchema>;

/**
 * Command to install a skill (PR26).
 */
export const SkillsInstallCommandSchema = z.object({
  sourceDir: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
});

export type SkillsInstallCommand = z.infer<typeof SkillsInstallCommandSchema>;

/**
 * Command to uninstall a skill (PR26).
 */
export const SkillsUninstallCommandSchema = z.object({
  skillId: z.string().trim().min(1),
});

export type SkillsUninstallCommand = z.infer<typeof SkillsUninstallCommandSchema>;

/**
 * Command to enable a skill (PR26).
 */
export const SkillsEnableCommandSchema = z.object({
  skillId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
});

export type SkillsEnableCommand = z.infer<typeof SkillsEnableCommandSchema>;

/**
 * Command to disable a skill (PR26).
 */
export const SkillsDisableCommandSchema = z.object({
  skillId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
});

export type SkillsDisableCommand = z.infer<typeof SkillsDisableCommandSchema>;

/**
 * Command to get a skill info (PR26).
 */
export const SkillsGetCommandSchema = z.object({
  skillId: z.string().trim().min(1),
});

export type SkillsGetCommand = z.infer<typeof SkillsGetCommandSchema>;

/**
 * Command to load reference content on demand (PR26).
 */
export const SkillsReferencesLoadCommandSchema = z.object({
  skillId: z.string().trim().min(1),
  relativePath: z.string().trim().min(1),
});

export type SkillsReferencesLoadCommand = z.infer<typeof SkillsReferencesLoadCommandSchema>;

/**
 * Command to list import_guard facts (PR28).
 */
export const MemoryListCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    category: z
      .enum(["preference", "fact", "instruction", "project_context", "workflow"])
      .optional(),
    includeSuperseded: z.boolean().optional(),
  })
  .optional()
  .default({});

export type MemoryListCommand = z.infer<typeof MemoryListCommandSchema>;

/**
 * Command to get a single import_guard fact (PR28).
 */
export const MemoryGetCommandSchema = z.object({
  id: z.string().trim().min(1),
});

export type MemoryGetCommand = z.infer<typeof MemoryGetCommandSchema>;

/**
 * Command to update a import_guard fact (PR28).
 */
export const MemoryUpdateCommandSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1).max(2000).optional(),
  category: z.enum(["preference", "fact", "instruction", "project_context", "workflow"]).optional(),
  sensitivity: z.enum(["normal", "sensitive"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type MemoryUpdateCommand = z.infer<typeof MemoryUpdateCommandSchema>;

/**
 * Command to delete a import_guard fact (PR28).
 */
export const MemoryDeleteCommandSchema = z.object({
  id: z.string().trim().min(1),
});

export type MemoryDeleteCommand = z.infer<typeof MemoryDeleteCommandSchema>;

/**
 * Command to search memories with relevance retrieval (PR28).
 */
export const MemorySearchCommandSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  category: z.enum(["preference", "fact", "instruction", "project_context", "workflow"]).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export type MemorySearchCommand = z.infer<typeof MemorySearchCommandSchema>;

/**
 * Command to supersede a import_guard fact with a replacement (PR28).
 */
export const MemorySupersedeCommandSchema = z.object({
  id: z.string().trim().min(1),
  supersededBy: z.string().trim().min(1),
});

export type MemorySupersedeCommand = z.infer<typeof MemorySupersedeCommandSchema>;

// ---------------------------------------------------------------------------
// Agent Runtime Commands (PR29)
// ---------------------------------------------------------------------------

/**
 * Command to start a new agent task run (TaskGraph durable skeleton + per-node ReAct).
 */
export const AgentStartCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  goal: z.string().trim().min(1).max(4000),
  projectId: z.string().trim().min(1).max(256).optional(),
  modelId: z.string().trim().min(1).max(128).optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  maxNodeIterations: z.number().int().positive().max(50).optional(),
});

export type AgentStartCommand = z.infer<typeof AgentStartCommandSchema>;

/**
 * Command to cancel a running agent task (downward-only cancellation).
 */
export const AgentCancelCommandSchema = z.object({
  taskId: TaskIdSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

export type AgentCancelCommand = z.infer<typeof AgentCancelCommandSchema>;

/**
 * Command to fetch one agent task's status snapshot.
 */
export const AgentGetCommandSchema = z.object({
  taskId: TaskIdSchema,
});

export type AgentGetCommand = z.infer<typeof AgentGetCommandSchema>;

/**
 * Command to list known agent task ids (in-process registry).
 */
export const AgentListCommandSchema = z.object({});

export type AgentListCommand = z.infer<typeof AgentListCommandSchema>;

// ---------------------------------------------------------------------------
// Coding Agent Commands (PR30)
// ---------------------------------------------------------------------------

/**
 * Command to start a coding task (workspace-bound, project-scoped).
 */
export const CodingStartCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  workspaceRoot: z.string().trim().min(1).max(1024).optional(),
  cwd: z.string().trim().min(1).max(1024).optional(),
  prompt: z.string().trim().min(1).max(4000),
  conversationId: ConversationIdSchema.optional(),
  modelId: z.string().trim().min(1).max(128).optional(),
  maxNodeIterations: z.number().int().positive().max(50).optional(),
});

export type CodingStartCommand = z.infer<typeof CodingStartCommandSchema>;

/**
 * Command to cancel a running coding task (downward-only).
 */
export const CodingCancelCommandSchema = z.object({
  taskId: TaskIdSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

export type CodingCancelCommand = z.infer<typeof CodingCancelCommandSchema>;

/**
 * Command to fetch one coding task's status snapshot.
 */
export const CodingGetCommandSchema = z.object({
  taskId: TaskIdSchema,
});

export type CodingGetCommand = z.infer<typeof CodingGetCommandSchema>;

/**
 * Command to list known coding task ids (in-process registry).
 */
export const CodingListCommandSchema = z.object({});

export type CodingListCommand = z.infer<typeof CodingListCommandSchema>;

// ---------------------------------------------------------------------------
// Extension Commands (PR32)
// ---------------------------------------------------------------------------

/**
 * Command to list installed extensions, optionally filtered by project enablement (PR32).
 */
export const ExtensionListCommandSchema = z
  .object({
    projectId: z.string().trim().min(1).max(256).optional(),
  })
  .optional()
  .default({});

export type ExtensionListCommand = z.infer<typeof ExtensionListCommandSchema>;

/**
 * Command to get a single extension's info payload (PR32).
 */
export const ExtensionGetCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
});

export type ExtensionGetCommand = z.infer<typeof ExtensionGetCommandSchema>;

/**
 * Command to install an extension from a local source directory (PR32).
 */
export const ExtensionInstallCommandSchema = z.object({
  sourceDir: z.string().trim().min(1).max(1024),
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type ExtensionInstallCommand = z.infer<typeof ExtensionInstallCommandSchema>;

/**
 * Command to uninstall an installed extension (PR32).
 */
export const ExtensionUninstallCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
});

export type ExtensionUninstallCommand = z.infer<typeof ExtensionUninstallCommandSchema>;

/**
 * Command to enable an installed extension (PR32).
 */
export const ExtensionEnableCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
});

export type ExtensionEnableCommand = z.infer<typeof ExtensionEnableCommandSchema>;

/**
 * Command to disable an enabled extension (PR32).
 */
export const ExtensionDisableCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
});

export type ExtensionDisableCommand = z.infer<typeof ExtensionDisableCommandSchema>;

/**
 * Command to enable an extension for a specific project (PR32).
 */
export const ExtensionProjectEnableCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).max(256),
});

export type ExtensionProjectEnableCommand = z.infer<typeof ExtensionProjectEnableCommandSchema>;

/**
 * Command to disable an extension for a specific project (PR32).
 */
export const ExtensionProjectDisableCommandSchema = z.object({
  extensionId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).max(256),
});

export type ExtensionProjectDisableCommand = z.infer<typeof ExtensionProjectDisableCommandSchema>;

// ---------------------------------------------------------------------------
// Rich Surface Commands (PR33)
// ---------------------------------------------------------------------------

/**
 * Command to list surface instance snapshots, optionally scoped to a
 * project (PR33). Bounded by the registry's own per-task caps; not a
 * getEverything dump.
 */
export const SurfaceListCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type SurfaceListCommand = z.infer<typeof SurfaceListCommandSchema>;

/**
 * Command to fetch one surface instance snapshot (PR33).
 */
export const SurfaceGetCommandSchema = z.object({
  instanceId: z.string().trim().min(1).max(64),
});

export type SurfaceGetCommand = z.infer<typeof SurfaceGetCommandSchema>;

/**
 * Command to invoke a structured surface action (PR33). The action routes
 * through permission + the existing ToolExecutor path in main; the channel
 * itself never executes anything.
 */
export const SurfaceActionCommandSchema = z.object({
  instanceId: z.string().trim().min(1).max(64),
  actionId: z.string().trim().min(1).max(64),
  input: z.unknown().optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type SurfaceActionCommand = z.infer<typeof SurfaceActionCommandSchema>;

/**
 * Command to dispose a surface instance (PR33). Idempotent.
 */
export const SurfaceDisposeCommandSchema = z.object({
  instanceId: z.string().trim().min(1).max(64),
});

export type SurfaceDisposeCommand = z.infer<typeof SurfaceDisposeCommandSchema>;

// ---------------------------------------------------------------------------
// Browser Commands (PR34.5)
// NOTE: there is intentionally NO browser:execute channel — browser execution
// flows through the agent tool router (BrowserToolExecutor), never arbitrary IPC.
// ---------------------------------------------------------------------------

export const BrowserSessionCreateCommandSchema = z.object({
  projectId: z.string().trim().min(1),
  mode: z.enum(["isolated", "attached"]).optional(),
});

export type BrowserSessionCreateCommand = z.infer<typeof BrowserSessionCreateCommandSchema>;

export const BrowserSessionGetCommandSchema = z.object({
  sessionId: BrowserSessionIdSchema,
});

export type BrowserSessionGetCommand = z.infer<typeof BrowserSessionGetCommandSchema>;

export const BrowserSessionCloseCommandSchema = z.object({
  sessionId: BrowserSessionIdSchema,
});

export type BrowserSessionCloseCommand = z.infer<typeof BrowserSessionCloseCommandSchema>;

export const BrowserPageOpenCommandSchema = z.object({
  sessionId: BrowserSessionIdSchema.optional(),
  projectId: z.string().trim().min(1).optional(),
  url: z.string().trim().optional(),
  name: z.string().trim().optional(),
});

export type BrowserPageOpenCommand = z.infer<typeof BrowserPageOpenCommandSchema>;

export const BrowserPageListCommandSchema = z
  .object({
    sessionId: BrowserSessionIdSchema.optional(),
    projectId: z.string().trim().min(1).optional(),
  })
  .optional()
  .default({});

export type BrowserPageListCommand = z.infer<typeof BrowserPageListCommandSchema>;

export const BrowserPageGetCommandSchema = z.object({
  pageId: BrowserPageIdSchema,
});

export type BrowserPageGetCommand = z.infer<typeof BrowserPageGetCommandSchema>;

export const BrowserPageCloseCommandSchema = z.object({
  pageId: BrowserPageIdSchema,
});

export type BrowserPageCloseCommand = z.infer<typeof BrowserPageCloseCommandSchema>;

export const BrowserScreenshotCommandSchema = z.object({
  pageId: BrowserPageIdSchema,
  fullPage: z.boolean().optional(),
});

export type BrowserScreenshotCommand = z.infer<typeof BrowserScreenshotCommandSchema>;

// ---------------------------------------------------------------------------
// Research Commands (PR35)
// NOTE: there is intentionally NO research:execute channel — operations flow
// through the agent tool router (ResearchToolExecutor), never arbitrary IPC.
// ---------------------------------------------------------------------------

export const ResearchSearchCommandSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().positive().max(20).optional(),
  channel: z.enum(["web", "github"]).optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type ResearchSearchCommand = z.infer<typeof ResearchSearchCommandSchema>;

const DANGEROUS_IPC_URL_PATTERN = /^\s*(javascript|vbscript|data|file|blob|ftp|gopher):/i;

export const ResearchOpenCommandSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((val) => !DANGEROUS_IPC_URL_PATTERN.test(val), {
      message: "URL must use http(s) and must not use a dangerous scheme",
    })
    .refine(
      (val) => {
        try {
          const protocol = new URL(val).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "URL must use http(s)" },
    ),
  projectId: z.string().trim().min(1).max(256).optional(),
  fallbackToBrowser: z.boolean().optional(),
});

export type ResearchOpenCommand = z.infer<typeof ResearchOpenCommandSchema>;

export const ResearchStatusCommandSchema = z.object({}).optional().default({});

export type ResearchStatusCommand = z.infer<typeof ResearchStatusCommandSchema>;

// ---------------------------------------------------------------------------
// Document Commands (PR37)
// Ingestion travels as base64 (IPC-safe); main re-checks byte bounds after
// decoding. Tools accept DocumentId + projectId — never raw paths.
// ---------------------------------------------------------------------------

export const DocumentsListCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
});

export type DocumentsListCommand = z.infer<typeof DocumentsListCommandSchema>;

export const DocumentsGetCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  documentId: UlidStringSchema,
  maxChars: z.number().int().positive().max(20000).optional(),
});

export type DocumentsGetCommand = z.infer<typeof DocumentsGetCommandSchema>;

export const DocumentsSearchCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().positive().max(20).optional(),
});

export type DocumentsSearchCommand = z.infer<typeof DocumentsSearchCommandSchema>;

export const DocumentsIngestCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(128),
  contentBase64: z.string().min(1).max(14_000_000),
});

export type DocumentsIngestCommand = z.infer<typeof DocumentsIngestCommandSchema>;

export const DocumentsDeleteCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  documentId: UlidStringSchema,
});

export type DocumentsDeleteCommand = z.infer<typeof DocumentsDeleteCommandSchema>;

// ---------------------------------------------------------------------------
// Attachment Commands (PR39)
// Upload travels as base64 (IPC-safe); main re-checks byte bounds after
// decoding and validates image magic bytes. Preview returns bounded
// image-only thumbnail bytes (max 200KB); audio/video return a metadata
// card without bytes. There is intentionally NO attachments:read-path /
// media:readPath channel — the renderer never receives filesystem paths.
// ---------------------------------------------------------------------------

export const ATTACHMENTS_UPLOAD_MAX_BASE64 = 36_000_000;
export const ATTACHMENTS_PREVIEW_MAX_BYTES = 204_800;

export const AttachmentsListCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
});

export type AttachmentsListCommand = z.infer<typeof AttachmentsListCommandSchema>;

export const AttachmentsGetCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  attachmentId: UlidStringSchema,
});

export type AttachmentsGetCommand = z.infer<typeof AttachmentsGetCommandSchema>;

export const AttachmentsUploadCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(128),
  contentBase64: z.string().min(1).max(ATTACHMENTS_UPLOAD_MAX_BASE64),
});

export type AttachmentsUploadCommand = z.infer<typeof AttachmentsUploadCommandSchema>;

export const AttachmentsDeleteCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  attachmentId: UlidStringSchema,
});

export type AttachmentsDeleteCommand = z.infer<typeof AttachmentsDeleteCommandSchema>;

export const AttachmentsPreviewCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  attachmentId: UlidStringSchema,
  maxBytes: z.number().int().positive().max(ATTACHMENTS_PREVIEW_MAX_BYTES).optional(),
});

export type AttachmentsPreviewCommand = z.infer<typeof AttachmentsPreviewCommandSchema>;

// ---------------------------------------------------------------------------
// MCP Server Commands (PR38)
// NOTE: no mcp:execute — execution flows through the agent tool router.
// ---------------------------------------------------------------------------

const McpServerIdField = z.string().trim().min(1).max(128);

export const McpServerListCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type McpServerListCommand = z.infer<typeof McpServerListCommandSchema>;

export const McpServerGetCommandSchema = z.object({
  serverId: McpServerIdField,
});

export type McpServerGetCommand = z.infer<typeof McpServerGetCommandSchema>;

export const McpServerConnectCommandSchema = z.object({
  serverId: McpServerIdField,
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type McpServerConnectCommand = z.infer<typeof McpServerConnectCommandSchema>;

export const McpServerDisconnectCommandSchema = z.object({
  serverId: McpServerIdField,
});

export type McpServerDisconnectCommand = z.infer<typeof McpServerDisconnectCommandSchema>;

export const McpCapabilitiesCommandSchema = z.object({
  serverId: McpServerIdField,
});

export type McpCapabilitiesCommand = z.infer<typeof McpCapabilitiesCommandSchema>;

export const McpResourcesCommandSchema = z.object({
  serverId: McpServerIdField,
});

export type McpResourcesCommand = z.infer<typeof McpResourcesCommandSchema>;

export const McpResourceReadCommandSchema = z.object({
  serverId: McpServerIdField,
  uri: z.string().trim().min(1).max(2000),
  projectId: z.string().trim().min(1).max(256),
});

export type McpResourceReadCommand = z.infer<typeof McpResourceReadCommandSchema>;

export const McpPromptsCommandSchema = z.object({
  serverId: McpServerIdField,
});

export type McpPromptsCommand = z.infer<typeof McpPromptsCommandSchema>;

export const McpPromptGetCommandSchema = z.object({
  serverId: McpServerIdField,
  name: z.string().trim().min(1).max(128),
  projectId: z.string().trim().min(1).max(256),
});

export type McpPromptGetCommand = z.infer<typeof McpPromptGetCommandSchema>;

export const McpSubscribeCommandSchema = z.object({
  serverId: McpServerIdField,
  uri: z.string().trim().min(1).max(2000),
  projectId: z.string().trim().min(1).max(256),
});

export type McpSubscribeCommand = z.infer<typeof McpSubscribeCommandSchema>;

export const McpUnsubscribeCommandSchema = z.object({
  subscriptionId: z.string().trim().min(1).max(128),
});

export type McpUnsubscribeCommand = z.infer<typeof McpUnsubscribeCommandSchema>;

// ---------------------------------------------------------------------------
// Realtime Voice Commands (PR40)
// Audio travels as bounded base64 chunks; sessions/handles never cross IPC.
// ---------------------------------------------------------------------------

export const RealtimeCapabilitiesCommandSchema = z.object({
  modelId: z.string().trim().min(1).max(128).optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type RealtimeCapabilitiesCommand = z.infer<typeof RealtimeCapabilitiesCommandSchema>;

export const RealtimeSessionCreateCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  modelId: z.string().trim().min(1).max(128),
  providerId: z.string().trim().min(1).max(64).optional(),
  conversationId: z.string().trim().min(1).max(100).optional(),
  turnDetection: z.enum(["provider", "client", "manual"]).optional(),
});

export type RealtimeSessionCreateCommand = z.infer<typeof RealtimeSessionCreateCommandSchema>;

export const RealtimeSessionStartCommandSchema = z.object({
  sessionId: UlidStringSchema,
});

export type RealtimeSessionStartCommand = z.infer<typeof RealtimeSessionStartCommandSchema>;

export const RealtimeSessionInterruptCommandSchema = z.object({
  sessionId: UlidStringSchema,
});

export type RealtimeSessionInterruptCommand = z.infer<typeof RealtimeSessionInterruptCommandSchema>;

export const RealtimeSessionStopCommandSchema = z.object({
  sessionId: UlidStringSchema,
});

export type RealtimeSessionStopCommand = z.infer<typeof RealtimeSessionStopCommandSchema>;

export const RealtimeSessionGetCommandSchema = z.object({
  sessionId: UlidStringSchema,
});

export type RealtimeSessionGetCommand = z.infer<typeof RealtimeSessionGetCommandSchema>;

export const RealtimeSessionListCommandSchema = z.object({
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type RealtimeSessionListCommand = z.infer<typeof RealtimeSessionListCommandSchema>;

export const RealtimeTranscriptCommandSchema = z.object({
  sessionId: UlidStringSchema,
});

export type RealtimeTranscriptCommand = z.infer<typeof RealtimeTranscriptCommandSchema>;

export const RealtimeAudioCommandSchema = z.object({
  sessionId: UlidStringSchema,
  payloadBase64: z.string().min(1).max(87_380),
});

export type RealtimeAudioCommand = z.infer<typeof RealtimeAudioCommandSchema>;

// ---------------------------------------------------------------------------
// Desktop Workspace Commands (PR41)
// Project-scoped file, search, and diagnostics operations over the
// main-process WorkspaceFileService / WorkspaceSearchService /
// DiagnosticsService. Pagination-free and bounded: path fields 1..1024,
// content <= 256KB, query 1..200, diagnostics entries <= 500 per report.
// There is intentionally NO workspace:execute / filesystem:execute /
// shell:execute / node:execute schema — execution is never exposed on IPC.
// ---------------------------------------------------------------------------

export const WORKSPACE_CONTENT_MAX_CHARS = 262_144;
export const WORKSPACE_DIAGNOSTICS_REPORT_MAX = 500;

const WorkspaceProjectIdField = z.string().trim().min(1).max(256);
const WorkspacePathField = z.string().trim().min(1).max(1024);

export const WorkspaceFilesListCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField.optional(),
  depth: z.number().int().min(0).max(4).optional(),
});

export type WorkspaceFilesListCommand = z.infer<typeof WorkspaceFilesListCommandSchema>;

export const WorkspaceFilesReadCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField,
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().max(262_144).optional(),
});

export type WorkspaceFilesReadCommand = z.infer<typeof WorkspaceFilesReadCommandSchema>;

export const WorkspaceFilesWriteCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField,
  content: z.string().max(WORKSPACE_CONTENT_MAX_CHARS),
  expectedMtimeMs: z.number().nonnegative().optional(),
});

export type WorkspaceFilesWriteCommand = z.infer<typeof WorkspaceFilesWriteCommandSchema>;

export const WorkspaceFilesCreateCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField,
  content: z.string().max(WORKSPACE_CONTENT_MAX_CHARS).optional(),
  directory: z.boolean().optional(),
});

export type WorkspaceFilesCreateCommand = z.infer<typeof WorkspaceFilesCreateCommandSchema>;

export const WorkspaceFilesRenameCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  from: WorkspacePathField,
  to: WorkspacePathField,
});

export type WorkspaceFilesRenameCommand = z.infer<typeof WorkspaceFilesRenameCommandSchema>;

export const WorkspaceFilesDeleteCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField,
});

export type WorkspaceFilesDeleteCommand = z.infer<typeof WorkspaceFilesDeleteCommandSchema>;

export const WorkspaceSearchCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField.optional(),
  query: z.string().trim().min(1).max(200),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  include: z.string().trim().min(1).max(256).optional(),
  maxResults: z.number().int().positive().max(200).optional(),
});

export type WorkspaceSearchCommand = z.infer<typeof WorkspaceSearchCommandSchema>;

const WorkspaceDiagnosticSeveritySchema = z.enum(["error", "warning", "information", "hint"]);

export const WorkspaceDiagnosticsReportCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  source: z.string().trim().min(1).max(128),
  diagnostics: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1024),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        severity: WorkspaceDiagnosticSeveritySchema,
        message: z.string().trim().min(1).max(2000),
        code: z.string().trim().min(1).max(128).optional(),
      }),
    )
    .max(WORKSPACE_DIAGNOSTICS_REPORT_MAX),
});

export type WorkspaceDiagnosticsReportCommand = z.infer<
  typeof WorkspaceDiagnosticsReportCommandSchema
>;

export const WorkspaceDiagnosticsListCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  path: WorkspacePathField.optional(),
});

export type WorkspaceDiagnosticsListCommand = z.infer<typeof WorkspaceDiagnosticsListCommandSchema>;

export const WorkspaceDiagnosticsClearCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  source: z.string().trim().min(1).max(128).optional(),
});

export type WorkspaceDiagnosticsClearCommand = z.infer<
  typeof WorkspaceDiagnosticsClearCommandSchema
>;

// ---------------------------------------------------------------------------
// Terminal Commands (PR41)
// Sessions run commands through the PR27 ExecutionManager (sandboxed,
// permission-gated). No stdin channel (fail-closed), no shell spawning
// from renderer input beyond the sandboxed command execution.
// ---------------------------------------------------------------------------

export const TerminalListCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
});

export type TerminalListCommand = z.infer<typeof TerminalListCommandSchema>;

export const TerminalCreateCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  cwd: z.string().trim().min(1).max(1024).optional(),
  command: z.string().trim().min(1).max(2048).optional(),
  args: z.array(z.string().max(1024)).max(32).optional(),
  timeoutMs: z.number().int().positive().max(120000).optional(),
});

export type TerminalCreateCommand = z.infer<typeof TerminalCreateCommandSchema>;

export const TerminalWriteCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  sessionId: z.string().trim().min(1).max(128),
  input: z.string().max(4096),
});

export type TerminalWriteCommand = z.infer<typeof TerminalWriteCommandSchema>;

export const TerminalResizeCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  sessionId: z.string().trim().min(1).max(128),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(100),
});

export type TerminalResizeCommand = z.infer<typeof TerminalResizeCommandSchema>;

export const TerminalStopCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  sessionId: z.string().trim().min(1).max(128),
});

export type TerminalStopCommand = z.infer<typeof TerminalStopCommandSchema>;

export const TerminalOutputCommandSchema = z.object({
  projectId: WorkspaceProjectIdField,
  sessionId: z.string().trim().min(1).max(128),
  tailBytes: z.number().int().positive().max(32768).optional(),
});

export type TerminalOutputCommand = z.infer<typeof TerminalOutputCommandSchema>;

// ---------------------------------------------------------------------------
// Git Commands (PR42)
// Project-scoped repository inspection and staging operations over the
// main-process GitService. Bounded: project ids 1..256, paths 1..1024,
// stage/unstage path lists 1..500, log limit 1..100, commit messages
// 1..32768 chars. There is intentionally NO git:execute schema — execution
// is never exposed on IPC.
// ---------------------------------------------------------------------------

export const GitProjectId = z.string().trim().min(1).max(256);
export const GitPath = z.string().trim().min(1).max(1024);

export const GitDetectCommandSchema = z.object({
  projectId: GitProjectId,
});

export type GitDetectCommand = z.infer<typeof GitDetectCommandSchema>;

export const GitStatusCommandSchema = z.object({
  projectId: GitProjectId,
});

export type GitStatusCommand = z.infer<typeof GitStatusCommandSchema>;

export const GitDiffCommandSchema = z.object({
  projectId: GitProjectId,
  staged: z.boolean().default(false),
  path: GitPath.optional(),
});

export type GitDiffCommand = z.infer<typeof GitDiffCommandSchema>;

export const GitLogCommandSchema = z.object({
  projectId: GitProjectId,
  limit: z.number().int().min(1).max(100).default(20),
});

export type GitLogCommand = z.infer<typeof GitLogCommandSchema>;

export const GitBranchesCommandSchema = z.object({
  projectId: GitProjectId,
});

export type GitBranchesCommand = z.infer<typeof GitBranchesCommandSchema>;

export const GitStageCommandSchema = z.object({
  projectId: GitProjectId,
  paths: z.array(GitPath).min(1).max(500),
});

export type GitStageCommand = z.infer<typeof GitStageCommandSchema>;

export const GitUnstageCommandSchema = z.object({
  projectId: GitProjectId,
  paths: z.array(GitPath).min(1).max(500),
});

export type GitUnstageCommand = z.infer<typeof GitUnstageCommandSchema>;

export const GitCommitCommandSchema = z.object({
  projectId: GitProjectId,
  message: z.string().trim().min(1).max(32768),
});

export type GitCommitCommand = z.infer<typeof GitCommitCommandSchema>;

// ---------------------------------------------------------------------------
// Background Task Commands (PR43)
// Long-running background agents over the main-process
// DesktopBackgroundTaskService. Project-scoped, renderer-safe projections
// only (taskId/projectId/title/status/mode/timestamps/attempt/lastError/
// resultSummary/nodeCount/currentNode). Bounded: project ids 1..256,
// titles 1..120, goals 1..4000, input replies 1..2000, cancel reasons
// 1..500. There is intentionally NO background-tasks:execute schema —
// execution is never exposed on IPC.
// ---------------------------------------------------------------------------

export const BackgroundTasksProjectId = z.string().trim().min(1).max(256);

export const BackgroundTasksListCommandSchema = z.object({
  projectId: BackgroundTasksProjectId,
});

export type BackgroundTasksListCommand = z.infer<typeof BackgroundTasksListCommandSchema>;

export const BackgroundTasksGetCommandSchema = z.object({
  taskId: TaskIdSchema,
  projectId: BackgroundTasksProjectId,
});

export type BackgroundTasksGetCommand = z.infer<typeof BackgroundTasksGetCommandSchema>;

export const BackgroundTasksStartCommandSchema = z.object({
  projectId: BackgroundTasksProjectId,
  goal: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(120).optional(),
  conversationId: ConversationIdSchema.optional(),
  modelId: z.string().trim().min(1).max(128).optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  maxNodeIterations: z.number().int().min(1).max(50).optional(),
});

export type BackgroundTasksStartCommand = z.infer<typeof BackgroundTasksStartCommandSchema>;

export const BackgroundTasksPauseCommandSchema = z.object({
  taskId: TaskIdSchema,
  projectId: BackgroundTasksProjectId,
});

export type BackgroundTasksPauseCommand = z.infer<typeof BackgroundTasksPauseCommandSchema>;

export const BackgroundTasksResumeCommandSchema = z.object({
  taskId: TaskIdSchema,
  projectId: BackgroundTasksProjectId,
});

export type BackgroundTasksResumeCommand = z.infer<typeof BackgroundTasksResumeCommandSchema>;

export const BackgroundTasksCancelCommandSchema = z.object({
  taskId: TaskIdSchema,
  projectId: BackgroundTasksProjectId,
  reason: z.string().trim().min(1).max(500).optional(),
});

export type BackgroundTasksCancelCommand = z.infer<typeof BackgroundTasksCancelCommandSchema>;

export const BackgroundTasksRespondCommandSchema = z.object({
  taskId: TaskIdSchema,
  projectId: BackgroundTasksProjectId,
  input: z.string().trim().min(1).max(2000),
});

export type BackgroundTasksRespondCommand = z.infer<typeof BackgroundTasksRespondCommandSchema>;

// ---------------------------------------------------------------------------
// Scheduled Task Commands (PR44)
// Autonomous schedules over the main-process DesktopSchedulerService.
// Project-scoped, renderer-safe projections only (scheduleId/projectId/name/
// description/prompt/schedule/timezone/policies/timestamps/counters; run
// rows carry trigger/status/timestamps/error only). Bounded: project ids
// 1..256, names 1..120, prompts 1..4000, descriptions <=2000, timezones
// 1..64, intervals >= 60s (sub-minute rejected), run history queries 1..100.
// There is intentionally NO schedules:execute schema — execution is never
// exposed on IPC.
// ---------------------------------------------------------------------------

export const SchedulesProjectId = z.string().trim().min(1).max(256);

export const ScheduleIdSchema = UlidStringSchema.transform((val) => val.toUpperCase());

export const ScheduleOnceSpecSchema = z.object({
  kind: z.literal("once"),
  runAt: z.string().trim().min(1).max(64),
  at: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]).optional(),
});

export const ScheduleDelaySpecSchema = z.object({
  kind: z.literal("delay"),
  delayMs: z.number().int().min(1000).max(31_536_000_000),
});

export const ScheduleIntervalSpecSchema = z.object({
  kind: z.literal("interval"),
  intervalMs: z.number().int().min(60_000).max(31_536_000_000),
});

export const ScheduleDailySpecSchema = z.object({
  kind: z.literal("daily"),
  dailyTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "dailyTime must be HH:MM (00:00-23:59)" }),
});

export const ScheduleWeeklySpecSchema = z.object({
  kind: z.literal("weekly"),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export const ScheduleSpecSchema = z.discriminatedUnion("kind", [
  ScheduleOnceSpecSchema,
  ScheduleDelaySpecSchema,
  ScheduleIntervalSpecSchema,
  ScheduleDailySpecSchema,
  ScheduleWeeklySpecSchema,
]);

export type ScheduleSpecCommand = z.infer<typeof ScheduleSpecSchema>;

export const SchedulesMissedPolicySchema = z.enum(["skip", "run_once"]);

export const SchedulesOverlapPolicySchema = z
  .enum(["skip", "queue", "queue_one"])
  .transform((val) => (val === "queue" ? "queue_one" : val));

export const SchedulesListCommandSchema = z.object({
  projectId: SchedulesProjectId,
});

export type SchedulesListCommand = z.infer<typeof SchedulesListCommandSchema>;

export const SchedulesGetCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
});

export type SchedulesGetCommand = z.infer<typeof SchedulesGetCommandSchema>;

export const SchedulesCreateCommandSchema = z.object({
  projectId: SchedulesProjectId,
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  schedule: ScheduleSpecSchema,
  timezone: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(2000).optional(),
  missedPolicy: SchedulesMissedPolicySchema.optional(),
  overlapPolicy: SchedulesOverlapPolicySchema.optional(),
  enabled: z.boolean().optional(),
});

export type SchedulesCreateCommand = z.infer<typeof SchedulesCreateCommandSchema>;

export const SchedulesUpdateCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  schedule: ScheduleSpecSchema.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  missedPolicy: SchedulesMissedPolicySchema.optional(),
  overlapPolicy: SchedulesOverlapPolicySchema.optional(),
});

export type SchedulesUpdateCommand = z.infer<typeof SchedulesUpdateCommandSchema>;

export const SchedulesEnableCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
});

export type SchedulesEnableCommand = z.infer<typeof SchedulesEnableCommandSchema>;

export const SchedulesDisableCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
});

export type SchedulesDisableCommand = z.infer<typeof SchedulesDisableCommandSchema>;

export const SchedulesDeleteCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
});

export type SchedulesDeleteCommand = z.infer<typeof SchedulesDeleteCommandSchema>;

export const SchedulesRunNowCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
});

export type SchedulesRunNowCommand = z.infer<typeof SchedulesRunNowCommandSchema>;

export const SchedulesRunsCommandSchema = z.object({
  scheduleId: ScheduleIdSchema,
  projectId: SchedulesProjectId,
  limit: z.number().int().min(1).max(100).optional(),
});

export type SchedulesRunsCommand = z.infer<typeof SchedulesRunsCommandSchema>;

// ---------------------------------------------------------------------------
// Account Commands (PR45)
// Local account identity over the main-process AccountService. Renderer-safe
// projections only (accountId/displayName/email/session/device — never
// refresh tokens, nonces, or SecretRefs). Bounded: displayName 1..120,
// email 1..256 when present. There is intentionally NO account:execute
// schema — credentials never cross IPC.
// ---------------------------------------------------------------------------

export const AccountGetCommandSchema = z.object({});

export type AccountGetCommand = z.infer<typeof AccountGetCommandSchema>;

export const AccountSignInCommandSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().min(1).max(256).optional(),
});

export type AccountSignInCommand = z.infer<typeof AccountSignInCommandSchema>;

export const AccountSignOutCommandSchema = z.object({});

export type AccountSignOutCommand = z.infer<typeof AccountSignOutCommandSchema>;

export const AccountRefreshCommandSchema = z.object({});

export type AccountRefreshCommand = z.infer<typeof AccountRefreshCommandSchema>;

export const AccountDeviceCommandSchema = z.object({});

export type AccountDeviceCommand = z.infer<typeof AccountDeviceCommandSchema>;

// ---------------------------------------------------------------------------
// Sync Commands (PR45)
// Cross-device sync over the main-process SyncService. Renderer-safe
// projections only (status/cursors/conflicts — never record payload secrets
// beyond validated entity data). Bounded: conflict listing 1..100,
// conflictId 1..128, projectId 1..256. There is intentionally NO
// sync:execute schema — sync execution stays main-side behind the
// transport port with bounded validation.
// ---------------------------------------------------------------------------

export const SyncStatusCommandSchema = z.object({});

export type SyncStatusCommand = z.infer<typeof SyncStatusCommandSchema>;

export const SyncStartCommandSchema = z.object({});

export type SyncStartCommand = z.infer<typeof SyncStartCommandSchema>;

export const SyncPauseCommandSchema = z.object({});

export type SyncPauseCommand = z.infer<typeof SyncPauseCommandSchema>;

export const SyncConflictsCommandSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

export type SyncConflictsCommand = z.infer<typeof SyncConflictsCommandSchema>;

export const SyncResolveCommandSchema = z.object({
  conflictId: z.string().trim().min(1).max(128),
  resolution: z.enum(["keep-local", "keep-remote"]),
  // Optional: conflicts are globally keyed by conflictId; the renderer
  // resolve call sends only conflictId + resolution choice.
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type SyncResolveCommand = z.infer<typeof SyncResolveCommandSchema>;

// ---------------------------------------------------------------------------
// Extension Payloads (PR32)
// ---------------------------------------------------------------------------

/**
 * Renderer-facing extension info: lifecycle + trust + binding snapshot.
 * NOTE: there is intentionally NO extension:execute channel — execution flows
 * through the agent tool router (plugin: prefix), never through IPC.
 */
export const ExtensionLifecycleSchema = z.enum(["installed", "enabled", "active", "disabled"]);

export type ExtensionLifecycle = z.infer<typeof ExtensionLifecycleSchema>;

export const ExtensionTrustSchema = z.enum(["untrusted", "trusted", "blocked"]);

export type ExtensionTrust = z.infer<typeof ExtensionTrustSchema>;

export const ExtensionInfoPayloadSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  capabilities: z.array(z.string()),
  lifecycle: ExtensionLifecycleSchema,
  trust: ExtensionTrustSchema,
  manifestHash: z.string().trim().min(1),
  installedAt: z.number(),
  updatedAt: z.number(),
  enabledProjects: z.array(z.string()),
});

export type ExtensionInfoPayload = z.infer<typeof ExtensionInfoPayloadSchema>;

// ---------------------------------------------------------------------------
// Event Contracts (Main Process -> Renderer)
// ---------------------------------------------------------------------------

export const ChatStreamEventKindSchema = z.enum([
  "delta",
  "status",
  "tool_call",
  "tool_result",
  "error",
  "done",
]);

export type ChatStreamEventKind = z.infer<typeof ChatStreamEventKindSchema>;

export const ChatStreamDeltaPayloadSchema = z.object({
  text: z.string(),
  messageId: MessageIdSchema.optional(),
});

export const ChatStreamStatusPayloadSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
});

export const ChatStreamToolCallPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  arguments: z.unknown(),
});

export const ChatStreamToolResultPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const ChatStreamErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const ChatStreamDonePayloadSchema = z.object({
  messageId: MessageIdSchema.optional(),
  finishReason: z.string().optional(),
});

export const ChatStreamEventSchema = z.object({
  conversationId: ConversationIdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: TimestampStringSchema,
  kind: ChatStreamEventKindSchema,
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("delta"), delta: ChatStreamDeltaPayloadSchema }),
    z.object({ kind: z.literal("status"), status: ChatStreamStatusPayloadSchema }),
    z.object({ kind: z.literal("tool_call"), toolCall: ChatStreamToolCallPayloadSchema }),
    z.object({ kind: z.literal("tool_result"), toolResult: ChatStreamToolResultPayloadSchema }),
    z.object({ kind: z.literal("error"), error: ChatStreamErrorPayloadSchema }),
    z.object({ kind: z.literal("done"), done: ChatStreamDonePayloadSchema }),
  ]),
});

export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

// ---------------------------------------------------------------------------
// Generic Envelope Wrappers (for typed IPC calls)
// ---------------------------------------------------------------------------

export interface IpcRequestEnvelope<T> {
  readonly id: string;
  readonly channel: string;
  readonly payload: T;
  readonly timestamp: Timestamp;
}

export type IpcResponseEnvelope<T> =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

// ---------------------------------------------------------------------------
// Runtime Validation Helpers (returning Result<T, ValidationError>)
// ---------------------------------------------------------------------------

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
}

export function validateChatSendCommand(input: unknown): Result<ChatSendCommand, ValidationError> {
  const parsed = ChatSendCommandSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatSendCommand: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}

export function validateChatCancelCommand(
  input: unknown,
): Result<ChatCancelCommand, ValidationError> {
  const parsed = ChatCancelCommandSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatCancelCommand: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}

export function validateChatStreamEvent(input: unknown): Result<ChatStreamEvent, ValidationError> {
  const parsed = ChatStreamEventSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatStreamEvent: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}
