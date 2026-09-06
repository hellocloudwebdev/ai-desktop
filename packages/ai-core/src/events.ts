// PR4: packages/ai-core — Canonical AIEvent Model
//
// Architectural Principle:
//   Events are authoritative, immutable, append-only domain records.
//   Every persisted event requires sequence, schemaVersion, and timestamp.
//
// Hierarchy:
//   AIEvent
//   ├── CoreEvent        (conversation, message lifecycle, errors)
//   ├── CapabilityEvent  (tool calls, permissions, execution)
//   └── ExtensionEvent   (task graph, external extensions)

import { z } from "zod";
import {
  ConversationIdSchema,
  MessageIdSchema,
  PermissionRequestIdSchema,
  TaskIdSchema,
  TimestampStringSchema,
  ToolCallIdSchema,
} from "@ai-desktop/shared";
import { EventIdSchema, ExecutionIdSchema, TaskNodeIdSchema } from "./identifiers.js";
import { ContentPartSchema } from "./content.js";
import { ToolRuntimeSchema, ToolSourceSchema } from "./tools.js";
import { PermissionScopeSchema, RiskLevelSchema } from "./permissions.js";
import { ExecutionModeSchema } from "./execution.js";
import { TaskNodeSchema, TaskNodeStatusSchema } from "./tasks.js";

export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Base Event Envelope Schema
// ---------------------------------------------------------------------------

const BaseEventFields = {
  eventId: EventIdSchema,
  conversationId: ConversationIdSchema,
  sequence: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  timestamp: TimestampStringSchema,
};

// ---------------------------------------------------------------------------
// 1. Core Events
// ---------------------------------------------------------------------------

export const ConversationCreatedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("conversation.created"),
  category: z.literal("core"),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MessageCreatedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.created"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.array(ContentPartSchema),
});

export const MessageStartedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.started"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.array(ContentPartSchema).default([]),
});

export const MessageDeltaEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.delta"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  deltaText: z.string(),
});

export const MessageCompletedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.completed"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  finishReason: z.string().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export const MessageFailedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.failed"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  error: z.string(),
  code: z.string().optional(),
});

export const MessageCancelledEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message.cancelled"),
  category: z.literal("core"),
  messageId: MessageIdSchema,
  reason: z.string().optional(),
});

export const ErrorEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("error"),
  category: z.literal("core"),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  relatedEntityId: z.string().optional(),
});

export const CoreEventSchema = z.discriminatedUnion("type", [
  ConversationCreatedEventSchema,
  MessageCreatedEventSchema,
  MessageStartedEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  MessageFailedEventSchema,
  MessageCancelledEventSchema,
  ErrorEventSchema,
]);

export type ConversationCreatedEvent = z.infer<typeof ConversationCreatedEventSchema>;
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;
export type MessageStartedEvent = z.infer<typeof MessageStartedEventSchema>;
export type MessageDeltaEvent = z.infer<typeof MessageDeltaEventSchema>;
export type MessageCompletedEvent = z.infer<typeof MessageCompletedEventSchema>;
export type MessageFailedEvent = z.infer<typeof MessageFailedEventSchema>;
export type MessageCancelledEvent = z.infer<typeof MessageCancelledEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type CoreEvent = z.infer<typeof CoreEventSchema>;

// ---------------------------------------------------------------------------
// 2. Capability Events (Tools, Permissions, Executions)
// ---------------------------------------------------------------------------

export const ToolCallRequestedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool.call.requested"),
  category: z.literal("capability"),
  toolCallId: ToolCallIdSchema,
  toolName: z.string().min(1),
  toolSource: ToolSourceSchema,
  toolRuntime: ToolRuntimeSchema,
  input: z.unknown(),
});

export const ToolCallStartedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool.call.started"),
  category: z.literal("capability"),
  toolCallId: ToolCallIdSchema,
});

export const ToolCallCompletedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool.call.completed"),
  category: z.literal("capability"),
  toolCallId: ToolCallIdSchema,
  result: z.unknown(),
  durationMs: z.number().nonnegative().optional(),
});

export const ToolCallFailedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool.call.failed"),
  category: z.literal("capability"),
  toolCallId: ToolCallIdSchema,
  error: z.string(),
  durationMs: z.number().nonnegative().optional(),
});

export const PermissionRequestedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("permission.requested"),
  category: z.literal("capability"),
  permissionRequestId: PermissionRequestIdSchema,
  relatedToolCallIds: z.array(ToolCallIdSchema).min(1),
  capability: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  risk: RiskLevelSchema,
  scope: PermissionScopeSchema,
});

export const PermissionGrantedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("permission.granted"),
  category: z.literal("capability"),
  permissionRequestId: PermissionRequestIdSchema,
  scope: PermissionScopeSchema,
  reason: z.string().optional(),
});

export const PermissionDeniedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("permission.denied"),
  category: z.literal("capability"),
  permissionRequestId: PermissionRequestIdSchema,
  reason: z.string().optional(),
});

export const ExecutionRequestedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("execution.requested"),
  category: z.literal("capability"),
  executionId: ExecutionIdSchema,
  relatedToolCallId: ToolCallIdSchema.optional(),
  command: z.string().min(1),
  mode: ExecutionModeSchema,
});

export const ExecutionStartedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("execution.started"),
  category: z.literal("capability"),
  executionId: ExecutionIdSchema,
});

export const ExecutionCompletedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("execution.completed"),
  category: z.literal("capability"),
  executionId: ExecutionIdSchema,
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
});

export const ExecutionFailedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("execution.failed"),
  category: z.literal("capability"),
  executionId: ExecutionIdSchema,
  error: z.string(),
  exitCode: z.number().int().optional(),
});

export const CapabilityEventSchema = z.discriminatedUnion("type", [
  ToolCallRequestedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallCompletedEventSchema,
  ToolCallFailedEventSchema,
  PermissionRequestedEventSchema,
  PermissionGrantedEventSchema,
  PermissionDeniedEventSchema,
  ExecutionRequestedEventSchema,
  ExecutionStartedEventSchema,
  ExecutionCompletedEventSchema,
  ExecutionFailedEventSchema,
]);

export type ToolCallRequestedEvent = z.infer<typeof ToolCallRequestedEventSchema>;
export type ToolCallStartedEvent = z.infer<typeof ToolCallStartedEventSchema>;
export type ToolCallCompletedEvent = z.infer<typeof ToolCallCompletedEventSchema>;
export type ToolCallFailedEvent = z.infer<typeof ToolCallFailedEventSchema>;
export type PermissionRequestedEvent = z.infer<typeof PermissionRequestedEventSchema>;
export type PermissionGrantedEvent = z.infer<typeof PermissionGrantedEventSchema>;
export type PermissionDeniedEvent = z.infer<typeof PermissionDeniedEventSchema>;
export type ExecutionRequestedEvent = z.infer<typeof ExecutionRequestedEventSchema>;
export type ExecutionStartedEvent = z.infer<typeof ExecutionStartedEventSchema>;
export type ExecutionCompletedEvent = z.infer<typeof ExecutionCompletedEventSchema>;
export type ExecutionFailedEvent = z.infer<typeof ExecutionFailedEventSchema>;
export type CapabilityEvent = z.infer<typeof CapabilityEventSchema>;

// ---------------------------------------------------------------------------
// 3. Extension Events (Task Graph & External Extensions)
// ---------------------------------------------------------------------------

export const TaskCreatedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.created"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  title: z.string().min(1),
  rootNodeIds: z.array(TaskNodeIdSchema),
});

export const TaskNodeStartedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.node.started"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  taskNodeId: TaskNodeIdSchema,
});

export const TaskNodeCompletedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.node.completed"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  taskNodeId: TaskNodeIdSchema,
  result: z.unknown().optional(),
});

export const TaskNodeFailedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.node.failed"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  taskNodeId: TaskNodeIdSchema,
  error: z.string(),
});

export const TaskCompletedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.completed"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
});

export const TaskFailedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.failed"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  error: z.string(),
});

export const TaskCancelledEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.cancelled"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  reason: z.string().optional(),
});

export const TaskStartedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.started"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
});

export const TaskProgressEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.progress"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  nodeId: TaskNodeIdSchema.optional(),
  progress: z.number().min(0).max(1).optional(),
  status: TaskNodeStatusSchema.optional(),
  detail: z.string().optional(),
});

export const TaskSubtaskCreatedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.subtask.created"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  nodeId: TaskNodeIdSchema,
  parentId: TaskNodeIdSchema.optional(),
  goal: z.string().min(1),
  dependsOn: z.array(TaskNodeIdSchema).optional().default([]),
  status: TaskNodeStatusSchema.optional().default("pending"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const TaskBlockedEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.blocked"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  nodeId: TaskNodeIdSchema.optional(),
  reason: z.string().min(1),
});

export const TaskReplanEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("task.replan"),
  category: z.literal("extension"),
  taskId: TaskIdSchema,
  reason: z.string().optional(),
  addedNodes: z.array(TaskNodeSchema).optional(),
  removedNodeIds: z.array(TaskNodeIdSchema).optional(),
  updatedDependencies: z.record(z.string(), z.array(TaskNodeIdSchema)).optional(),
});

export const ExtensionCustomEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("extension.custom"),
  category: z.literal("extension"),
  extensionName: z.string().min(1),
  payload: z.unknown(),
});

export const ExtensionEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskStartedEventSchema,
  TaskProgressEventSchema,
  TaskSubtaskCreatedEventSchema,
  TaskBlockedEventSchema,
  TaskReplanEventSchema,
  TaskNodeStartedEventSchema,
  TaskNodeCompletedEventSchema,
  TaskNodeFailedEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  TaskCancelledEventSchema,
  ExtensionCustomEventSchema,
]);

export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;
export type TaskStartedEvent = z.infer<typeof TaskStartedEventSchema>;
export type TaskProgressEvent = z.infer<typeof TaskProgressEventSchema>;
export type TaskSubtaskCreatedEvent = z.infer<typeof TaskSubtaskCreatedEventSchema>;
export type TaskBlockedEvent = z.infer<typeof TaskBlockedEventSchema>;
export type TaskReplanEvent = z.infer<typeof TaskReplanEventSchema>;
export type TaskNodeStartedEvent = z.infer<typeof TaskNodeStartedEventSchema>;
export type TaskNodeCompletedEvent = z.infer<typeof TaskNodeCompletedEventSchema>;
export type TaskNodeFailedEvent = z.infer<typeof TaskNodeFailedEventSchema>;
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEventSchema>;
export type TaskFailedEvent = z.infer<typeof TaskFailedEventSchema>;
export type TaskCancelledEvent = z.infer<typeof TaskCancelledEventSchema>;
export type ExtensionCustomEvent = z.infer<typeof ExtensionCustomEventSchema>;
export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;

// ---------------------------------------------------------------------------
// Unified AIEvent Discriminated Union
// ---------------------------------------------------------------------------

export type AIEvent = CoreEvent | CapabilityEvent | ExtensionEvent;

export const AIEventTypeSchema = z.enum([
  // Core
  "conversation.created",
  "message.created",
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "message.cancelled",
  "error",
  // Capability
  "tool.call.requested",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "permission.requested",
  "permission.granted",
  "permission.denied",
  "execution.requested",
  "execution.started",
  "execution.completed",
  "execution.failed",
  // Extension
  "task.created",
  "task.started",
  "task.progress",
  "task.subtask.created",
  "task.blocked",
  "task.replan",
  "task.node.started",
  "task.node.completed",
  "task.node.failed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "extension.custom",
]);

export type AIEventType = z.infer<typeof AIEventTypeSchema>;

export const AIEventCategorySchema = z.enum(["core", "capability", "extension"]);
export type AIEventCategory = z.infer<typeof AIEventCategorySchema>;

export const AIEventSchema = z.discriminatedUnion("type", [
  ConversationCreatedEventSchema,
  MessageCreatedEventSchema,
  MessageStartedEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  MessageFailedEventSchema,
  MessageCancelledEventSchema,
  ErrorEventSchema,
  ToolCallRequestedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallCompletedEventSchema,
  ToolCallFailedEventSchema,
  PermissionRequestedEventSchema,
  PermissionGrantedEventSchema,
  PermissionDeniedEventSchema,
  ExecutionRequestedEventSchema,
  ExecutionStartedEventSchema,
  ExecutionCompletedEventSchema,
  ExecutionFailedEventSchema,
  TaskCreatedEventSchema,
  TaskStartedEventSchema,
  TaskProgressEventSchema,
  TaskSubtaskCreatedEventSchema,
  TaskBlockedEventSchema,
  TaskReplanEventSchema,
  TaskNodeStartedEventSchema,
  TaskNodeCompletedEventSchema,
  TaskNodeFailedEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  TaskCancelledEventSchema,
  ExtensionCustomEventSchema,
]);

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

export function isCoreEvent(event: AIEvent): event is CoreEvent {
  return event.category === "core";
}

export function isCapabilityEvent(event: AIEvent): event is CapabilityEvent {
  return event.category === "capability";
}

export function isExtensionEvent(event: AIEvent): event is ExtensionEvent {
  return event.category === "extension";
}
