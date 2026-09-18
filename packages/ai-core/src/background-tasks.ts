// PR43: packages/ai-core — Background & Long-Running Task Contracts
//
// Pure domain contracts for background agents: execution mode, lifecycle
// statuses + legal transitions, durable record/input/projection schemas,
// crash-recovery classification, error taxonomy, secret guard, and event names.
//
// Dependency rule:
//   ai-core -> shared (ai-core may ONLY depend on @ai-desktop/shared)
//
// Zero Electron, Prisma, child_process, filesystem, or network imports.
// NO runtime logic here: no manager, queue, scheduler, or persistence writer.
// The concurrency caps below are enforced by the future manager/queue layer,
// never by these schemas.
//
// Concurrency + bound rationale (derived from existing runtime conventions):
//   - Agent loop default `maxNodeIterations = 12` (agent-runtime): each
//     background agent may fan out up to 12 node turns, each turn able to raise
//     tool calls and permission checkpoints. Capping concurrent background
//     agents at MAX_BACKGROUND_TASKS (4) bounds the worst-case in-flight
//     tool/permission surface a user must supervise.
//   - Permission batching (permissions.ts `batchId`): a background task parked
//     in `waiting_permission` still holds a worker slot while the user reviews
//     the batch. MAX_BACKGROUND_TASKS_PER_PROJECT (2) stops one project from
//     starving the global pool with parked approval batches.
//   - MAX_BACKGROUND_QUEUE (16) = 4x active capacity: absorbs bursts without
//     unbounded memory growth; overflow surfaces a `queue-full` error.
//   - Text bounds mirror neighbouring contracts: title 120 (IPC-friendly),
//     node-level goal text 2000 (memory-fact content bound), errors 2000,
//     result summaries and system prompts 8000.
//
// Exactly-once limitation:
//   Persistence records *intent*, not external side effects. A crash between a
//   tool call and its event commit leaves uncertainty: the record may say
//   `running` while the side effect already happened. Therefore:
//     - Never auto-replay non-idempotent tools on recovery.
//     - Uncertain operations surface as `requires_approval`, never `resumable`.
//     - `resumable` is reserved for fresh (attempt <= 1) queued/running tasks
//       whose first replay is still idempotent-safe by construction.

import { z } from "zod";
import { ConversationIdSchema, TaskIdSchema, TimestampStringSchema } from "@ai-desktop/shared";
import { TaskNodeIdSchema } from "./identifiers.js";
import { TaskNodeStatusSchema } from "./tasks.js";

// ---------------------------------------------------------------------------
// Execution Mode
// ---------------------------------------------------------------------------

export const BackgroundExecutionModeSchema = z.enum(["foreground", "background"]);
export type BackgroundExecutionMode = z.infer<typeof BackgroundExecutionModeSchema>;

// ---------------------------------------------------------------------------
// Lifecycle Statuses + Legal Transitions
// ---------------------------------------------------------------------------

export const BackgroundTaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_permission",
  "waiting_input",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatusSchema>;

/**
 * Legal status transitions. Terminal states (completed/failed/cancelled) fan
 * out to nothing. `paused` restores via `queued` so the task re-enters the
 * scheduler instead of jumping straight back to `running`.
 */
export const STATUS_TRANSITIONS: Record<BackgroundTaskStatus, readonly BackgroundTaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: [
    "waiting_permission",
    "waiting_input",
    "paused",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_permission: ["running", "cancelled", "paused"],
  waiting_input: ["running", "cancelled", "paused"],
  paused: ["queued", "cancelled"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isLegalBackgroundTransition(
  from: BackgroundTaskStatus,
  to: BackgroundTaskStatus,
): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Concurrency Limits + Text Bounds
// ---------------------------------------------------------------------------

export const MAX_BACKGROUND_TASKS = 4;
export const MAX_BACKGROUND_TASKS_PER_PROJECT = 2;
export const MAX_BACKGROUND_QUEUE = 16;
export const MAX_BACKGROUND_TITLE_LENGTH = 120;
export const MAX_BACKGROUND_INPUT_LENGTH = 2000;
export const MAX_BACKGROUND_ERROR_LENGTH = 2000;
export const MAX_BACKGROUND_RESULT_LENGTH = 8000;

// ---------------------------------------------------------------------------
// Durable Record / Start Input / Renderer-Safe Projection
// ---------------------------------------------------------------------------

export const BackgroundTaskRecordSchema = z.object({
  taskId: TaskIdSchema,
  conversationId: ConversationIdSchema,
  projectId: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(MAX_BACKGROUND_TITLE_LENGTH),
  goal: z.string().trim().min(1).max(4000),
  mode: z.literal("background"),
  status: BackgroundTaskStatusSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
  startedAt: TimestampStringSchema.optional(),
  completedAt: TimestampStringSchema.optional(),
  attempt: z.number().int().min(0).default(0),
  lastError: z.string().max(MAX_BACKGROUND_ERROR_LENGTH).optional(),
  resultSummary: z.string().max(MAX_BACKGROUND_RESULT_LENGTH).optional(),
  nodeCount: z.number().int().min(0).optional(),
  schemaVersion: z.number().int().positive(),
});
export type BackgroundTaskRecord = z.infer<typeof BackgroundTaskRecordSchema>;

export const BackgroundTaskInputSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(MAX_BACKGROUND_TITLE_LENGTH).optional(),
  goal: z.string().trim().min(1).max(4000),
  conversationId: ConversationIdSchema.optional(),
  modelId: z.string().trim().min(1).max(128).optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  maxNodeIterations: z.number().int().min(1).max(50).optional(),
});
export type BackgroundTaskInput = z.infer<typeof BackgroundTaskInputSchema>;

export const BackgroundTaskProjectionSchema = z.object({
  taskId: TaskIdSchema,
  projectId: z.string().min(1).max(256),
  title: z.string().min(1).max(MAX_BACKGROUND_TITLE_LENGTH),
  status: BackgroundTaskStatusSchema,
  mode: z.literal("background"),
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
  startedAt: TimestampStringSchema.optional(),
  completedAt: TimestampStringSchema.optional(),
  attempt: z.number().int().min(0).default(0),
  lastError: z.string().max(MAX_BACKGROUND_ERROR_LENGTH).optional(),
  resultSummary: z.string().max(MAX_BACKGROUND_RESULT_LENGTH).optional(),
  nodeCount: z.number().int().min(0).optional(),
  currentNode: z
    .object({
      id: TaskNodeIdSchema,
      goal: z.string().min(1).max(MAX_BACKGROUND_INPUT_LENGTH),
      status: TaskNodeStatusSchema,
    })
    .optional(),
});
export type BackgroundTaskProjection = z.infer<typeof BackgroundTaskProjectionSchema>;

// ---------------------------------------------------------------------------
// Recovery Semantics
// ---------------------------------------------------------------------------

export const RecoveryDispositionSchema = z.enum(["resumable", "requires_approval", "abandoned"]);
export type RecoveryDisposition = z.infer<typeof RecoveryDispositionSchema>;

/**
 * Classifies a persisted background task after a crash/restart.
 *
 *   - `running`/`queued` with attempt <= 1 → `resumable` (first replay is
 *     idempotent-safe by construction).
 *   - `running`/`queued` with attempt > 1 → `requires_approval` (repeated
 *     attempts imply uncertain side effects; a human decides).
 *   - `waiting_permission`/`waiting_input`/`cancelling`/`paused` →
 *     `requires_approval` (an external party or in-flight cancel owns the
 *     next step; never auto-resume).
 *   - Terminal (`completed`/`failed`/`cancelled`) → `abandoned` (nothing left
 *     to recover).
 */
export function classifyRecovery(record: {
  status: BackgroundTaskStatus;
  attempt: number;
}): RecoveryDisposition {
  switch (record.status) {
    case "running":
    case "queued":
      return record.attempt <= 1 ? "resumable" : "requires_approval";
    case "waiting_permission":
    case "waiting_input":
    case "cancelling":
    case "paused":
      return "requires_approval";
    case "completed":
    case "failed":
    case "cancelled":
      return "abandoned";
  }
}

// ---------------------------------------------------------------------------
// Error Taxonomy
// ---------------------------------------------------------------------------

export const BackgroundTaskErrorCodeSchema = z.enum([
  "not-found",
  "project-mismatch",
  "invalid-transition",
  "queue-full",
  "concurrency-limited",
  "task-active",
  "secret-refused",
  "validation-error",
  "storage-error",
  "cancelled",
]);
export type BackgroundTaskErrorCode = z.infer<typeof BackgroundTaskErrorCodeSchema>;

export interface BackgroundTaskError {
  readonly code: BackgroundTaskErrorCode;
  readonly message: string;
}

export function toBackgroundError(
  code: BackgroundTaskErrorCode,
  message: string,
): BackgroundTaskError {
  return { code: BackgroundTaskErrorCodeSchema.parse(code), message };
}

// ---------------------------------------------------------------------------
// Secret Guard (for persistence writers)
// ---------------------------------------------------------------------------

export const SECRET_KEYS_PATTERN =
  /(api[_-]?key|oauth|token|secret|password|credential|authorization)/i;

/**
 * Rejects values that appear to carry raw secret material. Persistence writers
 * must call this before storing background-task payloads: only secure
 * references belong in storage, never raw keys/tokens/passwords. The thrown
 * message carries a fixed prefix and never echoes the offending value.
 */
export function assertNoSecrets(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  if (SECRET_KEYS_PATTERN.test(serialized)) {
    throw new Error(
      "secret-refused: value appears to contain secret material; store a secure reference instead",
    );
  }
}

// ---------------------------------------------------------------------------
// Background Event Names (`task.background.*`)
// ---------------------------------------------------------------------------

export const BACKGROUND_EVENT_TYPES = [
  "started",
  "queued",
  "waiting_permission",
  "waiting_input",
  "paused",
  "resumed",
  "completed",
  "failed",
  "cancelled",
  "recovered",
] as const;
export type BackgroundEventType = (typeof BACKGROUND_EVENT_TYPES)[number];

export const BackgroundEventTypeSchema = z.enum(BACKGROUND_EVENT_TYPES);

/**
 * Builds a `task.background.<type>` event name, rejecting anything outside
 * the allowlist so producers cannot invent ad-hoc event types.
 */
export function backgroundEventType(type: string): `task.background.${BackgroundEventType}` {
  if (!(BACKGROUND_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid background event type: "${type}"`);
  }
  return `task.background.${type as BackgroundEventType}`;
}
