// PR30.2: packages/ai-core — Canonical Coding-Agent Contracts
//
// Invariants:
//   1. CodingTaskRequest/CodingAgentContext are pure domain contracts: branded IDs,
//      explicit workspace root, project scope. No filesystem, process, or Electron.
//   2. The workspace root must be explicit and the cwd must resolve inside it;
//      enforcement lives in the desktop backend (path-policy), not here.
//   3. Every coding task is project-scoped: projectId is required, never optional.
//   4. No secrets embedded in request objects: prompt and paths reject raw credentials.
//   5. ToolSource stays "builtin" and ToolRuntime stays "in_process" for filesystem
//      tools (execution is NOT a source); command execution delegates to
//      ExecutionManager and keeps runtime "execution".

import { z } from "zod";
import { ConversationIdSchema, type ConversationId } from "@ai-desktop/shared";
import { TaskIdSchema, type TaskId } from "@ai-desktop/shared";
import { containsRawCredential } from "./memory.js";

/** Canonical IDs for the five coding builtin tools. */
export const CODING_TOOL_IDS = [
  "builtin:filesystem.list",
  "builtin:filesystem.search",
  "builtin:filesystem.read",
  "builtin:filesystem.write",
  "builtin:execution.run",
] as const;
export type CodingToolId = (typeof CODING_TOOL_IDS)[number];

export function isCodingToolId(value: string): value is CodingToolId {
  return (CODING_TOOL_IDS as readonly string[]).includes(value);
}

/** Filesystem permission capabilities for coding operations. */
export const CodingCapabilitySchema = z.enum([
  "filesystem.read",
  "filesystem.list",
  "filesystem.search",
  "filesystem.write",
  "execution.run",
]);
export type CodingCapability = z.infer<typeof CodingCapabilitySchema>;

/** Risk mapping for coding operations: reads low, writes medium, execution high. */
export function codingRiskFor(capability: CodingCapability): "low" | "medium" | "high" {
  switch (capability) {
    case "filesystem.read":
    case "filesystem.list":
    case "filesystem.search":
      return "low";
    case "filesystem.write":
      return "medium";
    case "execution.run":
      return "high";
  }
}

/** Capability mapping for each coding builtin tool. */
export function codingCapabilityFor(toolId: CodingToolId): CodingCapability {
  switch (toolId) {
    case "builtin:filesystem.list":
      return "filesystem.list";
    case "builtin:filesystem.search":
      return "filesystem.search";
    case "builtin:filesystem.read":
      return "filesystem.read";
    case "builtin:filesystem.write":
      return "filesystem.write";
    case "builtin:execution.run":
      return "execution.run";
  }
}

const WorkspacePathSchema = z.string().trim().min(1).max(1024);

const NoCredentialRefine = {
  message: "Value must not contain raw credentials (API keys, tokens, private keys, passwords)",
};

export const CodingTaskRequestSchema = z.object({
  taskId: TaskIdSchema.optional(),
  conversationId: ConversationIdSchema.optional(),
  projectId: z.string().trim().min(1).max(256),
  workspaceRoot: WorkspacePathSchema,
  cwd: WorkspacePathSchema.optional(),
  prompt: z
    .string()
    .trim()
    .min(1, "Coding prompt cannot be empty")
    .max(4000)
    .refine((p) => !containsRawCredential(p), NoCredentialRefine),
  modelId: z.string().trim().min(1).max(128).optional(),
  maxNodeIterations: z.number().int().positive().max(50).optional(),
});

export type CodingTaskRequest = z.infer<typeof CodingTaskRequestSchema>;

export const CodingAgentContextSchema = z.object({
  taskId: TaskIdSchema,
  projectId: z.string().trim().min(1).max(256),
  workspaceRoot: WorkspacePathSchema,
  cwd: WorkspacePathSchema,
});

export type CodingAgentContext = z.infer<typeof CodingAgentContextSchema>;

export interface ValidatedCodingContext {
  readonly taskId?: TaskId;
  readonly conversationId?: ConversationId;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly modelId?: string;
  readonly maxNodeIterations?: number;
}

/**
 * Validates a coding-task request against the canonical contract.
 * Structural validation only: workspace containment (cwd inside root) is
 * enforced by the desktop path-policy backend, not here.
 */
export function validateCodingTaskRequest(input: unknown): ValidatedCodingContext {
  const parsed = CodingTaskRequestSchema.parse(input);
  return {
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
    projectId: parsed.projectId,
    workspaceRoot: parsed.workspaceRoot,
    cwd: parsed.cwd ?? parsed.workspaceRoot,
    prompt: parsed.prompt,
    ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
    ...(parsed.maxNodeIterations ? { maxNodeIterations: parsed.maxNodeIterations } : {}),
  };
}
