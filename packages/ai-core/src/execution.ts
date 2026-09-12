// PR4: packages/ai-core — Canonical Execution Contracts
//
// Architectural Boundary:
//   ai-core expresses execution capabilities, requirements, and outcomes.
//   It strictly NEVER references Docker, container sockets, child_process, or
//   engine-specific mechanisms. Execution engines reside exclusively in packages/execution.

import { z } from "zod";
import type { Timestamp, ToolCallId } from "@ai-desktop/shared";
import { TimestampStringSchema, ToolCallIdSchema } from "@ai-desktop/shared";
import type { ExecutionId } from "./identifiers.js";
import { ExecutionIdSchema } from "./identifiers.js";

export const ExecutionModeSchema = z.enum(["sandboxed", "host", "container"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const ResourceLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  memoryLimitMb: z.number().int().positive().optional(),
  cpuShares: z.number().positive().optional(),
  networkAllowed: z.boolean().default(false),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

/**
 * Canonical request to execute a capability or command in an isolated runtime.
 */
export const ExecutionRequestSchema = z.object({
  id: ExecutionIdSchema,
  relatedToolCallId: ToolCallIdSchema.optional(),
  mode: ExecutionModeSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  resourceLimits: ResourceLimitsSchema.optional(),
  timestamp: TimestampStringSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionRequest = {
  readonly id: ExecutionId;
  readonly relatedToolCallId?: ToolCallId;
  readonly mode: ExecutionMode;
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory?: string;
  readonly environmentVariables?: Readonly<Record<string, string>>;
  readonly resourceLimits?: ResourceLimits;
  readonly timestamp: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Canonical result of an execution.
 */
export const ExecutionResultSchema = z.object({
  executionId: ExecutionIdSchema,
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean().default(false),
  resourceUsage: z
    .object({
      peakMemoryMb: z.number().nonnegative().optional(),
      cpuTimeMs: z.number().nonnegative().optional(),
    })
    .optional(),
  timestamp: TimestampStringSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionResult = {
  readonly executionId: ExecutionId;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly resourceUsage?: {
    readonly peakMemoryMb?: number;
    readonly cpuTimeMs?: number;
  };
  readonly timestamp: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Canonical interface for executing isolated scripts and commands.
 * Implemented exclusively by packages/execution.
 */
export interface ExecutionManager {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
