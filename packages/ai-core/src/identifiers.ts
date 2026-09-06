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

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const EventIdSchema = UlidSchema.transform((val) => val.toUpperCase() as EventId);
export const ExecutionIdSchema = UlidSchema.transform((val) => val.toUpperCase() as ExecutionId);
export const TaskNodeIdSchema = UlidSchema.transform((val) => val.toUpperCase() as TaskNodeId);

export function createEventId(seedTime?: number): EventId {
  return generateUlid(seedTime) as EventId;
}

export function createExecutionId(seedTime?: number): ExecutionId {
  return generateUlid(seedTime) as ExecutionId;
}

export function createTaskNodeId(seedTime?: number): TaskNodeId {
  return generateUlid(seedTime) as TaskNodeId;
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
