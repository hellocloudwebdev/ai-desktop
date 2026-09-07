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
} from "@ai-desktop/shared";
import { z } from "zod";

export type { Brand, ConversationId, MessageId, TaskId, ToolCallId, PermissionRequestId };

export type EventId = Brand<string, "EventId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type TaskNodeId = Brand<string, "TaskNodeId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ModelId = Brand<string, "ModelId">;

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const EventIdSchema = UlidSchema.transform((val) => val.toUpperCase() as EventId);
export const ExecutionIdSchema = UlidSchema.transform((val) => val.toUpperCase() as ExecutionId);
export const TaskNodeIdSchema = UlidSchema.transform((val) => val.toUpperCase() as TaskNodeId);

// Provider and Model IDs are stable semantic identifiers (e.g. "anthropic", "claude-3-5-sonnet")
// rather than random ULIDs, but are strongly branded to prevent string confusion.
const SEMANTIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const ProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SEMANTIC_ID_PATTERN, {
    message: "ProviderId must be lowercase alphanumeric with optional dot/dash/underscore",
  })
  .transform((val) => val.toLowerCase() as ProviderId);

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(SEMANTIC_ID_PATTERN, {
    message: "ModelId must be lowercase alphanumeric with optional dot/dash/underscore",
  })
  .transform((val) => val.toLowerCase() as ModelId);

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
