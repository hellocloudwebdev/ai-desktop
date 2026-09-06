// PR4: packages/ai-core — Canonical Tool Contracts
//
// Architectural Invariant:
//   Tool Source != Tool Runtime
//   Tool Source: "builtin" | "mcp" | "skill" | "plugin" (provenance)
//   Tool Runtime: "in_process" | "execution" | "mcp_protocol" | "browser" (execution engine)
//
// Execution is NOT a ToolSource. A tool can have source="skill" and runtime="execution",
// or source="mcp" and runtime="mcp_protocol".

import { z } from "zod";
import type { Timestamp, ToolCallId } from "@ai-desktop/shared";
import { TimestampStringSchema, ToolCallIdSchema } from "@ai-desktop/shared";

export const ToolSourceSchema = z.enum(["builtin", "mcp", "skill", "plugin"]);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

export const ToolRuntimeSchema = z.enum(["in_process", "execution", "mcp_protocol", "browser"]);
export type ToolRuntime = z.infer<typeof ToolRuntimeSchema>;

export const ToolCallStatusSchema = z.enum([
  "pending",
  "executing",
  "completed",
  "failed",
  "cancelled",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/**
 * Canonical tool definition exposed to models and the tool registry.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  source: ToolSourceSchema,
  runtime: ToolRuntimeSchema,
  parameters: z.record(z.string(), z.unknown()), // JSON Schema
  requiredPermissions: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * Represents the complete lifecycle state of a tool call invocation.
 */
export const ToolCallSchema = z.object({
  id: ToolCallIdSchema,
  toolName: z.string().min(1),
  toolSource: ToolSourceSchema,
  toolRuntime: ToolRuntimeSchema,
  input: z.unknown(),
  status: ToolCallStatusSchema,
  createdAt: TimestampStringSchema,
  startedAt: TimestampStringSchema.optional(),
  completedAt: TimestampStringSchema.optional(),
  parentToolCallId: ToolCallIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ToolCall = {
  readonly id: ToolCallId;
  readonly toolName: string;
  readonly toolSource: ToolSource;
  readonly toolRuntime: ToolRuntime;
  readonly input: unknown;
  readonly status: ToolCallStatus;
  readonly createdAt: Timestamp;
  readonly startedAt?: Timestamp;
  readonly completedAt?: Timestamp;
  readonly parentToolCallId?: ToolCallId;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Canonical outcome of executing a tool call.
 */
export const ToolResultSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolName: z.string().min(1),
  result: z.unknown(),
  isError: z.boolean().default(false),
  durationMs: z.number().nonnegative().optional(),
  timestamp: TimestampStringSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ToolResult = {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
  readonly durationMs?: number;
  readonly timestamp: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};
