// PR4: packages/ai-core — Canonical Task Graph Contracts
//
// Architectural Scope:
//   Defines the durable Task and TaskNode graph vocabulary for the agent runtime.
//   Strictly contracts only — no planner, agent loop, or ReAct engine implementation.

import { z } from "zod";
import type { ConversationId, TaskId, Timestamp } from "@ai-desktop/shared";
import { ConversationIdSchema, TaskIdSchema, TimestampStringSchema } from "@ai-desktop/shared";
import type { TaskNodeId } from "./identifiers.js";
import { TaskNodeIdSchema } from "./identifiers.js";

export const TaskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskNodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "skipped",
]);
export type TaskNodeStatus = z.infer<typeof TaskNodeStatusSchema>;

/**
 * Represents an individual node in a task graph.
 */
export const TaskNodeSchema = z.object({
  id: TaskNodeIdSchema,
  taskId: TaskIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskNodeStatusSchema,
  dependencies: z.array(TaskNodeIdSchema).default([]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: TimestampStringSchema,
  startedAt: TimestampStringSchema.optional(),
  completedAt: TimestampStringSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type TaskNode = {
  readonly id: TaskNodeId;
  readonly taskId: TaskId;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskNodeStatus;
  readonly dependencies: readonly TaskNodeId[];
  readonly result?: unknown;
  readonly error?: string;
  readonly createdAt: Timestamp;
  readonly startedAt?: Timestamp;
  readonly completedAt?: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Represents a composite durable Task composed of a graph of TaskNodes.
 */
export const TaskSchema = z.object({
  id: TaskIdSchema,
  conversationId: ConversationIdSchema,
  title: z.string().min(1),
  status: TaskStatusSchema,
  nodes: z.record(z.string(), TaskNodeSchema),
  rootNodeIds: z.array(TaskNodeIdSchema),
  createdAt: TimestampStringSchema,
  completedAt: TimestampStringSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Task = {
  readonly id: TaskId;
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly status: TaskStatus;
  readonly nodes: Readonly<Record<TaskNodeId, TaskNode>>;
  readonly rootNodeIds: readonly TaskNodeId[];
  readonly createdAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};
