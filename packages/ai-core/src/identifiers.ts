// PR4: packages/ai-core — Domain Identifiers
//
// Reuses the core branded ULID model from @ai-desktop/shared and defines
// specialized domain identifiers for events, executions, and task nodes.
//
// Invariant: Never reuse logical entity IDs across entities.

import {
  type Brand,
  generateUlid,
  isUlid,
  type ConversationId,
  type MessageId,
  type TaskId,
  type ToolCallId,
  type PermissionRequestId,
  type SessionId,
  type MemoryFactId,
  createSessionId,
  parseSessionId,
  asSessionId,
  createMemoryFactId,
  parseMemoryFactId,
  asMemoryFactId,
  type ResearchRequestId,
  type ResearchSourceId,
  type ResearchResultId,
  type ResearchDocumentId,
  createResearchRequestId,
  createResearchSourceId,
  createResearchResultId,
  createResearchDocumentId,
  parseResearchRequestId,
  parseResearchSourceId,
  parseResearchResultId,
  parseResearchDocumentId,
  asResearchRequestId,
  asResearchSourceId,
  asResearchResultId,
  asResearchDocumentId,
} from "@ai-desktop/shared";
import { z } from "zod";

export type {
  Brand,
  ConversationId,
  MessageId,
  TaskId,
  ToolCallId,
  PermissionRequestId,
  SessionId,
  MemoryFactId,
  ResearchRequestId,
  ResearchSourceId,
  ResearchResultId,
  ResearchDocumentId,
};
export {
  createSessionId,
  parseSessionId,
  asSessionId,
  createMemoryFactId,
  parseMemoryFactId,
  asMemoryFactId,
  createResearchRequestId,
  createResearchSourceId,
  createResearchResultId,
  createResearchDocumentId,
  parseResearchRequestId,
  parseResearchSourceId,
  parseResearchResultId,
  parseResearchDocumentId,
  asResearchRequestId,
  asResearchSourceId,
  asResearchResultId,
  asResearchDocumentId,
};

export type EventId = Brand<string, "EventId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type TaskNodeId = Brand<string, "TaskNodeId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ModelId = Brand<string, "ModelId">;
export type SkillId = Brand<string, "SkillId">;
export type BrowserSessionId = Brand<string, "BrowserSessionId">;
export type BrowserContextId = Brand<string, "BrowserContextId">;
export type BrowserPageId = Brand<string, "BrowserPageId">;
export type BrowserActionId = Brand<string, "BrowserActionId">;
export type BrowserElementRef = Brand<string, "BrowserElementRef">;

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const EventIdSchema = UlidSchema.transform((val) => val.toUpperCase() as EventId);
export const ExecutionIdSchema = UlidSchema.transform((val) => val.toUpperCase() as ExecutionId);
export const TaskNodeIdSchema = UlidSchema.transform((val) => val.toUpperCase() as TaskNodeId);
export const SessionIdSchema = UlidSchema.transform((val) => val.toUpperCase() as SessionId);
export const MemoryFactIdSchema = UlidSchema.transform((val) => val.toUpperCase() as MemoryFactId);
export const BrowserSessionIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as BrowserSessionId,
);
export const BrowserContextIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as BrowserContextId,
);
export const BrowserPageIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as BrowserPageId,
);
export const BrowserActionIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as BrowserActionId,
);
export const ResearchRequestIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as ResearchRequestId,
);
export const ResearchSourceIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as ResearchSourceId,
);
export const ResearchResultIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as ResearchResultId,
);
export const ResearchDocumentIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as ResearchDocumentId,
);

const BROWSER_ELEMENT_REF_PATTERN = /^(ref\/)?[a-z0-9_-]+$/i;

export const BrowserElementRefSchema = z
  .string()
  .trim()
  .regex(BROWSER_ELEMENT_REF_PATTERN, {
    message: "BrowserElementRef must be a semantic ref matching /^(ref\\/)?[a-z0-9_-]+$/i",
  })
  .transform((val) => val as BrowserElementRef);

// Provider and Model IDs are stable semantic identifiers (e.g. "anthropic", "claude-3-5-sonnet", "gemini:gemini-2.5-flash")
// rather than random ULIDs, but are strongly branded to prevent string confusion.
const SEMANTIC_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export const ProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SEMANTIC_ID_PATTERN, {
    message: "ProviderId must be lowercase alphanumeric with optional dot/dash/underscore/colon",
  })
  .transform((val) => val.toLowerCase() as ProviderId);

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(SEMANTIC_ID_PATTERN, {
    message: "ModelId must be lowercase alphanumeric with optional dot/dash/underscore/colon",
  })
  .transform((val) => val.toLowerCase() as ModelId);

export const SkillIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SEMANTIC_ID_PATTERN, {
    message: "SkillId must be lowercase alphanumeric with optional dot/dash/underscore/colon",
  })
  .transform((val) => val.toLowerCase() as SkillId);

export function createEventId(seedTime?: number): EventId {
  return generateUlid(seedTime) as EventId;
}

export function createExecutionId(seedTime?: number): ExecutionId {
  return generateUlid(seedTime) as ExecutionId;
}

export function createTaskNodeId(seedTime?: number): TaskNodeId {
  return generateUlid(seedTime) as TaskNodeId;
}

export function asProviderId(raw: string): ProviderId {
  return raw.toLowerCase() as ProviderId;
}

export function asModelId(raw: string): ModelId {
  return raw.toLowerCase() as ModelId;
}

export function asSkillId(raw: string): SkillId {
  return raw.toLowerCase() as SkillId;
}

export function parseSkillId(raw: string): SkillId {
  return SkillIdSchema.parse(raw);
}

export function parseEventId(raw: string): EventId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid EventId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as EventId;
}

export function parseExecutionId(raw: string): ExecutionId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid ExecutionId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as ExecutionId;
}

export function parseTaskNodeId(raw: string): TaskNodeId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid TaskNodeId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as TaskNodeId;
}

export function asEventId(raw: string): EventId {
  return raw as EventId;
}

export function asExecutionId(raw: string): ExecutionId {
  return raw as ExecutionId;
}

export function asTaskNodeId(raw: string): TaskNodeId {
  return raw as TaskNodeId;
}

export function createBrowserSessionId(seedTime?: number): BrowserSessionId {
  return generateUlid(seedTime) as BrowserSessionId;
}

export function createBrowserContextId(seedTime?: number): BrowserContextId {
  return generateUlid(seedTime) as BrowserContextId;
}

export function createBrowserPageId(seedTime?: number): BrowserPageId {
  return generateUlid(seedTime) as BrowserPageId;
}

export function createBrowserActionId(seedTime?: number): BrowserActionId {
  return generateUlid(seedTime) as BrowserActionId;
}

export function parseBrowserSessionId(raw: string): BrowserSessionId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid BrowserSessionId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as BrowserSessionId;
}

export function parseBrowserContextId(raw: string): BrowserContextId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid BrowserContextId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as BrowserContextId;
}

export function parseBrowserPageId(raw: string): BrowserPageId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid BrowserPageId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as BrowserPageId;
}

export function parseBrowserActionId(raw: string): BrowserActionId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid BrowserActionId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as BrowserActionId;
}

export function parseBrowserElementRef(raw: string): BrowserElementRef {
  return BrowserElementRefSchema.parse(raw);
}

export function asBrowserSessionId(raw: string): BrowserSessionId {
  return raw as BrowserSessionId;
}

export function asBrowserContextId(raw: string): BrowserContextId {
  return raw as BrowserContextId;
}

export function asBrowserPageId(raw: string): BrowserPageId {
  return raw as BrowserPageId;
}

export function asBrowserActionId(raw: string): BrowserActionId {
  return raw as BrowserActionId;
}

export function asBrowserElementRef(raw: string): BrowserElementRef {
  return raw as BrowserElementRef;
}
