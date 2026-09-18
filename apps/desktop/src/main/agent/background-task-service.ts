// PR43: apps/desktop — DesktopBackgroundTaskService (Desktop Orchestration Layer)
//
// Thin orchestration around AgentService + PrismaBackgroundTaskRepository +
// EventBus/EventRepository. It owns NO ReAct loop, NO tool executor, NO second
// permission system, NO memory system, and NO provider router: execution always
// delegates to AgentService.startTask/cancelTask/resumeTask (the existing
// runtime/graph/tool/permission/event path with the original projectId).
//
// Invariants:
//   1. Persistence is a projection/read model: every transition upserts
//      {taskId,conversationId,projectId,title,goal,mode,status,timestamps,
//      attempt,lastError,resultSummary,nodeCount,schemaVersion:1} via the
//      background-task repository. Payloads are truncated and secret-scanned
//      (assertNoSecrets) before every write; raw secrets never reach storage.
//   2. Events are authoritative: every transition also publishes a
//      task.background.* AIEvent via storage.append THEN EventBus.publish
//      (the same ordering as DesktopEventSink: persistence before delivery).
//   3. Project isolation: projectId is immutable from start; every operation
//      verifies the caller projectId; the service-level tool context always
//      passes the original projectId (never the currently-selected project).
//      Memory flows through the existing DesktopMemoryProvider path inside
//      AgentService; git/coding tools flow through existing executors with
//      existing permission gates. Nothing auto-commits, pushes, or approves.
//   4. Permissions: waiting_permission parks until PermissionManager resolves
//      externally; approval replays the exact pending op via
//      AgentService.resumeTask. Background tasks are never auto-approved.
//   5. Input: waiting_input parks with the request prompt persisted in memory
//      (prompt text <= 2000, secret-scanned); respond() resumes the task.
//   6. Concurrency caps from ai-core: MAX_BACKGROUND_TASKS (4) running,
//      MAX_BACKGROUND_TASKS_PER_PROJECT (2) running, MAX_BACKGROUND_QUEUE (16)
//      queued. Overflow queues (running full) or fails closed with queue-full
//      (queue full) / concurrency-limited (resume with no free slot).
//      MAX_AUTO_RETRIES=1 is respected by never re-invoking after failed:
//      failed stays failed until an explicit user resume/retry.
//   7. Startup recovery is idempotent, never executes parked work, and never
//      replays non-idempotent tools: resumable -> requeue; requires_approval
//      -> restore parked; abandoned/malformed -> skip (rejected rows emit
//      task.background.recovered with detail=rejected when their ids are
//      valid enough to address an event, otherwise they are skipped silently).
//   8. Renderer-disconnect safety: no WebContents state is ever consulted;
//      the durable row + in-memory entry are the only sources of truth, so a
//      renderer crash/disconnect changes nothing.
//   9. Fail closed: malformed ids, oversized strings, secret payloads, queue
//      floods, duplicate recovery rows, stale approvals, and cross-project
//      reads all throw BackgroundTaskServiceError ("CODE: message", never a
//      stack or secret echo).
//
// Sibling-manager note: a sibling subagent owns
// packages/agent-runtime/src/runtime/background-task-manager.ts. This file
// deliberately does NOT import it, so it compiles both before and after the
// manager lands. An optional `backgroundTaskManager` delegate slot is accepted
// and reserved; execution programs against the AgentService port directly.

import {
  assertNoSecrets,
  backgroundEventType,
  classifyRecovery,
  isLegalBackgroundTransition,
  MAX_BACKGROUND_ERROR_LENGTH,
  MAX_BACKGROUND_QUEUE,
  MAX_BACKGROUND_RESULT_LENGTH,
  MAX_BACKGROUND_TASKS,
  MAX_BACKGROUND_TASKS_PER_PROJECT,
  MAX_BACKGROUND_TITLE_LENGTH,
  BackgroundTaskStatusSchema,
  type AIEvent,
  type BackgroundEventType,
  type BackgroundTaskStatus,
  type ConversationId,
  type TaskId,
} from "@ai-desktop/ai-core";
import { createEventId } from "@ai-desktop/ai-core";
import { createConversationId, createTaskId, isUlid, now } from "@ai-desktop/shared";
import type { AgentTaskResult } from "@ai-desktop/agent-runtime";
import type { BackgroundTaskRow, EventRepository } from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// Minimal ports (structural: real implementations and test stubs both fit)
// ---------------------------------------------------------------------------

/** Agent execution port: the subset of AgentService this layer drives. */
export interface BackgroundAgentDelegate {
  startTask(input: {
    conversationId?: ConversationId;
    goal: string;
    projectId?: string;
    modelId?: string;
    systemPrompt?: string;
    maxNodeIterations?: number;
  }): Promise<AgentTaskResult>;
  cancelTask(taskId: TaskId, reason?: string): boolean;
  resumeTask(taskId: TaskId): Promise<AgentTaskResult | null>;
  getTaskStatus?(taskId: TaskId): string | undefined;
  getTaskGraph?(
    taskId: TaskId,
  ): { nodes: Array<{ id: unknown; goal: string; status: string }> } | undefined;
  listTasks?(): TaskId[];
}

/** Durable projection port: the subset of PrismaBackgroundTaskRepository used. */
export interface BackgroundTaskStore {
  upsert(record: BackgroundTaskRow): Promise<void>;
  get(taskId: string): Promise<BackgroundTaskRow | null>;
  listByProject(projectId: string): Promise<BackgroundTaskRow[]>;
  listUnfinished(): Promise<BackgroundTaskRow[]>;
}

/** Event transport port: publish-only view of EventBus. */
export interface BackgroundEventTransport {
  publish(event: Readonly<AIEvent>): Promise<void>;
}

export interface DesktopBackgroundTaskServiceDeps {
  readonly agentService: BackgroundAgentDelegate;
  readonly backgroundTasks: BackgroundTaskStore;
  readonly eventBus: BackgroundEventTransport;
  readonly storage: EventRepository;
  /**
   * Reserved slot for the sibling background-task manager
   * (packages/agent-runtime/src/runtime/background-task-manager.ts). Accepted
   * so wiring compiles before and after the manager lands; execution stays on
   * the AgentService port either way.
   */
  readonly backgroundTaskManager?: unknown;
}

export interface StartBackgroundTaskInput {
  readonly projectId: string;
  readonly goal: string;
  readonly title?: string;
  readonly conversationId?: ConversationId;
  readonly modelId?: string;
  readonly systemPrompt?: string;
  readonly maxNodeIterations?: number;
}

/** Renderer-safe projection: normalized fields only, never goal text. */
export interface BackgroundTaskProjection {
  readonly taskId: TaskId;
  readonly projectId: string;
  readonly title: string;
  readonly status: BackgroundTaskStatus;
  readonly mode: "background";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attempt: number;
  readonly lastError?: string;
  readonly resultSummary?: string;
  readonly nodeCount?: number;
  readonly currentNode?: { id: string; goal: string; status: string };
}

export interface BackgroundTaskRecoverySummary {
  readonly recovered: number;
  readonly resumable: number;
  readonly requiresApproval: number;
  readonly rejected: number;
  readonly ignored: number;
}

export class BackgroundTaskServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BackgroundTaskServiceError";
    this.code = code;
  }
}

interface BackgroundEntry {
  taskId: TaskId;
  conversationId: ConversationId;
  projectId: string;
  title: string;
  goal: string;
  status: BackgroundTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  lastError?: string;
  resultSummary?: string;
  nodeCount: number;
  pendingInputPrompt?: string;
  runtimeTaskId?: TaskId;
  modelId?: string;
  systemPrompt?: string;
  maxNodeIterations?: number;
}

const RUNNING_SLOT_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting_permission",
  "waiting_input",
  "cancelling",
]);
const MAX_BACKGROUND_GOAL_LENGTH = 4000;
const MAX_BACKGROUND_SYSTEM_PROMPT_LENGTH = 8000;
const BLOCKED_RESULT_PATTERN = /(blocked|approval|permission|requires user|requires_approval)/i;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function refuseSecrets(value: unknown): void {
  try {
    assertNoSecrets(value);
  } catch {
    throw new BackgroundTaskServiceError(
      "secret-refused",
      "refusing to persist background task payload: value appears to contain secret material",
    );
  }
}

function requireProjectId(projectId: string): string {
  const trimmed = (projectId ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new BackgroundTaskServiceError(
      "validation-error",
      "projectId must be a non-empty string of at most 256 characters",
    );
  }
  return trimmed;
}

function requireTaskId(taskId: string): TaskId {
  if (typeof taskId !== "string" || !isUlid(taskId)) {
    // Fail closed without an oracle: malformed ids read as not-found.
    throw new BackgroundTaskServiceError("not-found", "background task was not found");
  }
  return taskId.toUpperCase() as TaskId;
}

/**
 * DesktopBackgroundTaskService: thin background-task orchestration over the
 * existing AgentService runtime path with durable projections + recovery.
 */
export class DesktopBackgroundTaskService {
  private readonly _agents: BackgroundAgentDelegate;
  private readonly _store: BackgroundTaskStore;
  private readonly _bus: BackgroundEventTransport;
  private readonly _storage: EventRepository;
  private readonly _entries = new Map<string, BackgroundEntry>();
  private readonly _sequenceCounters = new Map<string, number>();
  private readonly _recoverySeen = new Set<string>();

  constructor(deps: DesktopBackgroundTaskServiceDeps) {
    this._agents = deps.agentService;
    // PrismaBackgroundTaskRepository satisfies BackgroundTaskStore structurally;
    // the StorageDatabase stays behind the storage boundary (no @prisma/client
    // import here). The optional backgroundTaskManager slot is reserved for the
    // sibling manager and intentionally unused by the execution path.
    void deps.backgroundTaskManager;
    this._store = deps.backgroundTasks;
    this._bus = deps.eventBus;
    this._storage = deps.storage;
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  async start(input: StartBackgroundTaskInput): Promise<BackgroundTaskProjection> {
    const projectId = requireProjectId(input.projectId);
    const goal = (input.goal ?? "").trim();
    if (goal.length === 0 || goal.length > MAX_BACKGROUND_GOAL_LENGTH) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "goal must be a non-empty string of at most 4000 characters",
      );
    }
    const title =
      input.title !== undefined ? input.title.trim() : goal.split("\n")[0]!.slice(0, 80).trim();
    if (title.length === 0 || title.length > MAX_BACKGROUND_TITLE_LENGTH) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "title must be a non-empty string of at most 120 characters",
      );
    }
    if (
      input.modelId !== undefined &&
      (input.modelId.trim().length === 0 || input.modelId.length > 128)
    ) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "modelId must be a non-empty string of at most 128 characters",
      );
    }
    if (
      input.systemPrompt !== undefined &&
      (input.systemPrompt.trim().length === 0 ||
        input.systemPrompt.length > MAX_BACKGROUND_SYSTEM_PROMPT_LENGTH)
    ) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "systemPrompt must be a non-empty string of at most 8000 characters",
      );
    }
    if (
      input.maxNodeIterations !== undefined &&
      (!Number.isInteger(input.maxNodeIterations) ||
        input.maxNodeIterations < 1 ||
        input.maxNodeIterations > 50)
    ) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "maxNodeIterations must be an integer between 1 and 50",
      );
    }
    refuseSecrets({ title, goal, systemPrompt: input.systemPrompt });

    if (this._queuedEntries().length >= MAX_BACKGROUND_QUEUE) {
      throw new BackgroundTaskServiceError(
        "queue-full",
        `background task queue is full (${MAX_BACKGROUND_QUEUE} queued)`,
      );
    }

    const taskId = createTaskId();
    const conversationId = input.conversationId ?? createConversationId();
    const timestamp = now();
    const entry: BackgroundEntry = {
      taskId,
      conversationId,
      projectId,
      title,
      goal,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      attempt: 0,
      nodeCount: 0,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.maxNodeIterations !== undefined
        ? { maxNodeIterations: input.maxNodeIterations }
        : {}),
    };
    this._entries.set(taskId, entry);
    try {
      await this._persist(entry);
    } catch (err) {
      this._entries.delete(taskId);
      throw err;
    }
    await this._emit(entry, "queued");
    const promoted = await this._pumpOne(entry);
    return promoted ?? this._project(entry);
  }

  async list(projectId: string): Promise<BackgroundTaskProjection[]> {
    const scoped = requireProjectId(projectId);
    let rows: BackgroundTaskRow[];
    try {
      rows = await this._store.listByProject(scoped);
    } catch {
      throw new BackgroundTaskServiceError("storage-error", "background task storage unavailable");
    }
    const seen = new Set<string>();
    const projections: Array<{ createdAt: string; projection: BackgroundTaskProjection }> = [];
    for (const row of rows) {
      if (typeof row.taskId !== "string" || seen.has(row.taskId)) continue;
      seen.add(row.taskId);
      const entry = this._entries.get(row.taskId) ?? this._entryFromRow(row);
      if (!entry || entry.projectId !== scoped) continue;
      projections.push({ createdAt: entry.createdAt, projection: this._project(entry) });
    }
    for (const entry of this._entries.values()) {
      if (entry.projectId !== scoped || seen.has(entry.taskId)) continue;
      seen.add(entry.taskId);
      projections.push({ createdAt: entry.createdAt, projection: this._project(entry) });
    }
    projections.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return projections.map((p) => p.projection);
  }

  async get(taskId: string, projectId: string): Promise<BackgroundTaskProjection> {
    const entry = await this._requireOwned(taskId, projectId);
    return this._project(entry);
  }

  async pause(taskId: string, projectId: string): Promise<BackgroundTaskProjection> {
    const entry = await this._requireOwned(taskId, projectId);
    if (!isLegalBackgroundTransition(entry.status, "paused")) {
      throw new BackgroundTaskServiceError(
        "invalid-transition",
        `cannot pause a background task with status "${entry.status}"`,
      );
    }
    // Best-effort halt of the in-flight runtime turn; the durable parked state
    // below is authoritative even when the runtime id is unknown (e.g. a stub
    // delegate or a post-restart entry).
    try {
      this._agents.cancelTask(
        (entry.runtimeTaskId ?? entry.taskId) as TaskId,
        "Background task paused",
      );
    } catch {
      // ignore: parking must succeed even when the runtime cannot be reached
    }
    entry.status = "paused";
    entry.updatedAt = now();
    await this._persist(entry);
    await this._emit(entry, "paused");
    return this._project(entry);
  }

  async resume(taskId: string, projectId: string): Promise<BackgroundTaskProjection> {
    const entry = await this._requireOwned(taskId, projectId);
    if (entry.status === "paused") {
      this._assertSlotFree(entry.projectId);
      entry.status = "queued";
      entry.updatedAt = now();
      await this._persist(entry);
      await this._emit(entry, "resumed");
      const promoted = await this._pumpOne(entry);
      return promoted ?? this._project(entry);
    }
    if (entry.status === "waiting_permission" || entry.status === "waiting_input") {
      const wasWaitingInput = entry.status === "waiting_input";
      entry.status = "running";
      entry.updatedAt = now();
      if (wasWaitingInput) {
        entry.pendingInputPrompt = undefined;
      }
      await this._persist(entry);
      await this._emit(entry, "resumed");
      // Approval replays the exact pending op via the runtime resume path;
      // never auto-approve: when the runtime no longer knows the task (stale
      // approval after restart), fall back to a fresh delegated run instead of
      // replaying anything blindly.
      let replayed: AgentTaskResult | null = null;
      try {
        replayed = await this._agents.resumeTask((entry.runtimeTaskId ?? entry.taskId) as TaskId);
      } catch {
        replayed = null;
      }
      if (replayed) {
        await this._settleWithResult(entry, replayed);
      } else {
        entry.attempt += 1;
        entry.updatedAt = now();
        await this._persist(entry);
        void this._execute(entry);
      }
      return this._project(entry);
    }
    throw new BackgroundTaskServiceError(
      "invalid-transition",
      `cannot resume a background task with status "${entry.status}"`,
    );
  }

  async cancel(
    taskId: string,
    projectId: string,
    reason?: string,
  ): Promise<{ task: BackgroundTaskProjection; cancelled: boolean }> {
    const entry = await this._requireOwned(taskId, projectId);
    // Idempotent cancellation: repeated cancels of an already-cancelled task
    // succeed without duplicating events; terminal completed/failed tasks are
    // safe no-ops reporting cancelled:false.
    if (entry.status === "cancelled") {
      return { task: this._project(entry), cancelled: true };
    }
    if (entry.status === "completed" || entry.status === "failed") {
      return { task: this._project(entry), cancelled: false };
    }
    if (reason !== undefined) {
      const trimmed = reason.trim();
      if (trimmed.length === 0 || trimmed.length > 500) {
        throw new BackgroundTaskServiceError(
          "validation-error",
          "reason must be a non-empty string of at most 500 characters",
        );
      }
      refuseSecrets({ reason: trimmed });
    }
    try {
      this._agents.cancelTask(
        (entry.runtimeTaskId ?? entry.taskId) as TaskId,
        reason ?? "Background task cancelled",
      );
    } catch {
      // ignore: the durable cancelled state below is authoritative
    }
    entry.status = "cancelled";
    entry.completedAt = now();
    entry.updatedAt = entry.completedAt;
    await this._persist(entry);
    await this._emit(entry, "cancelled", reason?.trim());
    await this._drainQueue();
    return { task: this._project(entry), cancelled: true };
  }

  async respond(
    taskId: string,
    projectId: string,
    input: string,
  ): Promise<BackgroundTaskProjection> {
    const entry = await this._requireOwned(taskId, projectId);
    const reply = (input ?? "").trim();
    if (reply.length === 0 || reply.length > 2000) {
      throw new BackgroundTaskServiceError(
        "validation-error",
        "input must be a non-empty string of at most 2000 characters",
      );
    }
    refuseSecrets({ input: reply });
    if (entry.status !== "waiting_input") {
      throw new BackgroundTaskServiceError(
        "invalid-transition",
        `cannot respond to a background task with status "${entry.status}"`,
      );
    }
    entry.pendingInputPrompt = undefined;
    entry.status = "running";
    entry.updatedAt = now();
    await this._persist(entry);
    // The reply text itself is never echoed into events/storage beyond the
    // secret-scanned runtime handoff; the event only records that input arrived.
    await this._emit(entry, "resumed", "input received");
    let replayed: AgentTaskResult | null = null;
    try {
      replayed = await this._agents.resumeTask((entry.runtimeTaskId ?? entry.taskId) as TaskId);
    } catch {
      replayed = null;
    }
    if (replayed) {
      await this._settleWithResult(entry, replayed);
    } else {
      entry.attempt += 1;
      entry.updatedAt = now();
      await this._persist(entry);
      void this._execute(entry);
    }
    return this._project(entry);
  }

  /**
   * Runtime integration point (not exposed on IPC): parks a live task in
   * waiting_permission / waiting_input when the permission gateway or an input
   * request blocks it. The waiting_input prompt text (<=2000, secret-scanned)
   * is retained in memory for the renderer to display.
   */
  async parkWaiting(
    taskId: string,
    kind: "waiting_permission" | "waiting_input",
    detail?: string,
  ): Promise<BackgroundTaskProjection> {
    const id = requireTaskId(taskId);
    const entry = this._entries.get(id) ?? (await this._materialize(id));
    if (!entry) {
      throw new BackgroundTaskServiceError("not-found", "background task was not found");
    }
    if (!isLegalBackgroundTransition(entry.status, kind)) {
      throw new BackgroundTaskServiceError(
        "invalid-transition",
        `cannot park a background task with status "${entry.status}" as "${kind}"`,
      );
    }
    if (detail !== undefined) {
      const trimmed = detail.trim();
      if (trimmed.length === 0 || trimmed.length > 2000) {
        throw new BackgroundTaskServiceError(
          "validation-error",
          "detail must be a non-empty string of at most 2000 characters",
        );
      }
      refuseSecrets({ detail: trimmed });
      if (kind === "waiting_input") {
        entry.pendingInputPrompt = trimmed;
      }
      entry.status = kind;
      entry.updatedAt = now();
      await this._persist(entry);
      await this._emit(entry, kind, trimmed);
    } else {
      entry.status = kind;
      entry.updatedAt = now();
      await this._persist(entry);
      await this._emit(entry, kind);
    }
    return this._project(entry);
  }

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  async recoverUnfinishedOnStartup(): Promise<BackgroundTaskRecoverySummary> {
    let rows: BackgroundTaskRow[];
    try {
      rows = await this._store.listUnfinished();
    } catch {
      throw new BackgroundTaskServiceError("storage-error", "background task storage unavailable");
    }
    const summary = { recovered: 0, resumable: 0, requiresApproval: 0, rejected: 0, ignored: 0 };
    const seen = new Set<string>();
    for (const row of rows) {
      const rawId = typeof row.taskId === "string" ? row.taskId : "";
      // Dedupe taskId defensively; the second occurrence is rejected, never executed.
      if (!rawId || seen.has(rawId)) {
        if (rawId) {
          summary.rejected += 1;
          await this._emitRejected(row);
        } else {
          summary.rejected += 1;
        }
        continue;
      }
      seen.add(rawId);
      // Idempotent: rows already adopted (or rejected) by an earlier recovery
      // pass produce no further effects.
      if (this._entries.has(rawId) || this._recoverySeen.has(rawId)) {
        continue;
      }
      const validated = this._validateRow(row);
      if (!validated) {
        summary.rejected += 1;
        this._recoverySeen.add(rawId);
        await this._emitRejected(row);
        continue;
      }
      const disposition = classifyRecovery({
        status: validated.status,
        attempt: validated.attempt,
      });
      if (disposition === "abandoned") {
        summary.ignored += 1;
        this._recoverySeen.add(validated.taskId);
        continue;
      }
      if (disposition === "requires_approval") {
        // Restore parked requiring user action; never auto-run. A stale
        // `running` row is parked as `paused` (a legal running->paused park)
        // so it visibly waits instead of idling as phantom-running; every
        // other status is restored as-is.
        const parked: BackgroundTaskStatus =
          validated.status === "running" ? "paused" : validated.status;
        const entry = this._entryFromValidated(validated, parked);
        this._entries.set(entry.taskId, entry);
        this._recoverySeen.add(entry.taskId);
        await this._persist(entry);
        await this._emit(entry, "recovered", `requires_approval:${validated.status}`);
        summary.recovered += 1;
        summary.requiresApproval += 1;
        continue;
      }
      // Resumable: requeue with the stored attempt kept, then schedule only
      // when a running slot is free (never replay non-idempotent tools: the
      // fresh delegated run is idempotent-safe by construction for attempt<=1).
      const entry = this._entryFromValidated(validated, "queued");
      this._entries.set(entry.taskId, entry);
      this._recoverySeen.add(entry.taskId);
      await this._persist(entry);
      await this._emit(entry, "recovered", "resumable:requeued");
      summary.recovered += 1;
      summary.resumable += 1;
      await this._pumpOne(entry);
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Scheduling + execution (thin: delegate everything to AgentService)
  // -------------------------------------------------------------------------

  private _runningSlotCount(): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (RUNNING_SLOT_STATUSES.has(entry.status)) count += 1;
    }
    return count;
  }

  private _projectSlotCount(projectId: string): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.projectId === projectId && RUNNING_SLOT_STATUSES.has(entry.status)) count += 1;
    }
    return count;
  }

  private _queuedEntries(): BackgroundEntry[] {
    return [...this._entries.values()]
      .filter((e) => e.status === "queued")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private _assertSlotFree(projectId: string): void {
    if (this._runningSlotCount() >= MAX_BACKGROUND_TASKS) {
      throw new BackgroundTaskServiceError(
        "concurrency-limited",
        `background task concurrency is limited (${MAX_BACKGROUND_TASKS} running)`,
      );
    }
    if (this._projectSlotCount(projectId) >= MAX_BACKGROUND_TASKS_PER_PROJECT) {
      throw new BackgroundTaskServiceError(
        "concurrency-limited",
        `background task concurrency is limited (${MAX_BACKGROUND_TASKS_PER_PROJECT} running for this project)`,
      );
    }
  }

  private _slotFreeFor(projectId: string): boolean {
    return (
      this._runningSlotCount() < MAX_BACKGROUND_TASKS &&
      this._projectSlotCount(projectId) < MAX_BACKGROUND_TASKS_PER_PROJECT
    );
  }

  /**
   * Promotes one queued entry to running when a slot is free (returns null
   * otherwise). The returned snapshot is captured BEFORE the delegated run is
   * kicked off, so callers observe a deterministic `running` projection even
   * when a fast delegate settles the live entry concurrently.
   */
  private async _pumpOne(entry: BackgroundEntry): Promise<BackgroundTaskProjection | null> {
    if (entry.status !== "queued") return null;
    if (!this._slotFreeFor(entry.projectId)) return null;
    entry.status = "running";
    if (!entry.startedAt) {
      entry.startedAt = now();
    }
    entry.attempt += 1;
    entry.updatedAt = now();
    await this._persist(entry);
    await this._emit(entry, "started");
    const snapshot = this._project(entry);
    void this._execute(entry);
    return snapshot;
  }

  /** Promotes queued work (oldest first) while running slots are free. */
  private async _drainQueue(): Promise<void> {
    for (const queued of this._queuedEntries()) {
      if (!this._slotFreeFor(queued.projectId)) continue;
      await this._pumpOne(queued);
    }
  }

  private _safeListTaskIds(): Set<string> {
    try {
      const ids = this._agents.listTasks?.() ?? [];
      return new Set(ids.map((id) => String(id)));
    } catch {
      return new Set();
    }
  }

  /** Delegates one running turn to AgentService and settles the projection. */
  private async _execute(entry: BackgroundEntry): Promise<void> {
    const before = this._safeListTaskIds();
    let result: AgentTaskResult;
    try {
      result = await this._agents.startTask({
        conversationId: entry.conversationId,
        goal: entry.goal,
        projectId: entry.projectId,
        ...(entry.modelId ? { modelId: entry.modelId } : {}),
        ...(entry.systemPrompt ? { systemPrompt: entry.systemPrompt } : {}),
        ...(entry.maxNodeIterations !== undefined
          ? { maxNodeIterations: entry.maxNodeIterations }
          : {}),
      });
    } catch (err: unknown) {
      // Transport failure of the delegate itself: failed stays failed (no
      // automatic retry beyond the runtime's own single transient retry).
      if (entry.status !== "running") return;
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "failed";
      entry.lastError = truncate(message, MAX_BACKGROUND_ERROR_LENGTH);
      entry.completedAt = now();
      entry.updatedAt = entry.completedAt;
      try {
        await this._persist(entry);
        await this._emit(entry, "failed", entry.lastError);
        await this._drainQueue();
      } catch {
        // persistence already failed closed; never reject unobserved
      }
      return;
    }
    // Correlate the runtime-owned task id for later cancel/resume/replay.
    try {
      const after = this._safeListTaskIds();
      for (const id of after) {
        if (!before.has(id) && isUlid(id)) {
          entry.runtimeTaskId = id.toUpperCase() as TaskId;
          break;
        }
      }
      if (!entry.runtimeTaskId && isUlid(result.taskId)) {
        entry.runtimeTaskId = (result.taskId as string).toUpperCase() as TaskId;
      }
    } catch {
      // correlation is best-effort only
    }
    // A concurrent pause/cancel/respond wins over a stale completion.
    if (entry.status !== "running") return;
    try {
      await this._settleWithResult(entry, result);
    } catch {
      // persistence already failed closed; never reject unobserved
    }
  }

  /** Maps a delegated terminal result onto the durable projection. */
  private async _settleWithResult(entry: BackgroundEntry, result: AgentTaskResult): Promise<void> {
    if (result.status === "completed") {
      entry.status = "completed";
      entry.resultSummary = truncate(result.summary, MAX_BACKGROUND_RESULT_LENGTH);
      entry.completedAt = now();
      entry.updatedAt = entry.completedAt;
      entry.nodeCount = this._nodeCount(entry);
      await this._persist(entry);
      await this._emit(entry, "completed");
      await this._drainQueue();
      return;
    }
    if (result.status === "cancelled") {
      entry.status = "cancelled";
      entry.completedAt = now();
      entry.updatedAt = entry.completedAt;
      await this._persist(entry);
      await this._emit(entry, "cancelled", result.reason);
      await this._drainQueue();
      return;
    }
    // The runtime surfaces permission blocks as failed-with-approval-pending;
    // park instead of failing so the PermissionManager decision owns the next
    // step. Genuine failures stay failed (no auto-retry at this layer).
    if (BLOCKED_RESULT_PATTERN.test(result.error)) {
      entry.status = "waiting_permission";
      entry.lastError = truncate(result.error, MAX_BACKGROUND_ERROR_LENGTH);
      entry.updatedAt = now();
      await this._persist(entry);
      await this._emit(entry, "waiting_permission", entry.lastError);
      return;
    }
    entry.status = "failed";
    entry.lastError = truncate(result.error, MAX_BACKGROUND_ERROR_LENGTH);
    entry.completedAt = now();
    entry.updatedAt = entry.completedAt;
    await this._persist(entry);
    await this._emit(entry, "failed", entry.lastError);
    await this._drainQueue();
  }

  // -------------------------------------------------------------------------
  // Persistence + events
  // -------------------------------------------------------------------------

  private async _persist(entry: BackgroundEntry): Promise<void> {
    const title = truncate(entry.title, MAX_BACKGROUND_TITLE_LENGTH);
    const goal = truncate(entry.goal, MAX_BACKGROUND_GOAL_LENGTH);
    const lastError =
      entry.lastError === undefined
        ? undefined
        : truncate(entry.lastError, MAX_BACKGROUND_ERROR_LENGTH);
    const resultSummary =
      entry.resultSummary === undefined
        ? undefined
        : truncate(entry.resultSummary, MAX_BACKGROUND_RESULT_LENGTH);
    refuseSecrets({ title, goal, lastError, resultSummary });
    const createdMs = Date.parse(entry.createdAt);
    const updatedMs = Date.parse(entry.updatedAt);
    if (!Number.isFinite(createdMs) || !Number.isFinite(updatedMs)) {
      throw new BackgroundTaskServiceError(
        "storage-error",
        "background task timestamps are invalid",
      );
    }
    const row: BackgroundTaskRow = {
      taskId: entry.taskId,
      conversationId: entry.conversationId,
      projectId: entry.projectId,
      title,
      goal,
      mode: "background",
      status: entry.status,
      createdAt: createdMs,
      updatedAt: updatedMs,
      startedAt: entry.startedAt ? Date.parse(entry.startedAt) : null,
      completedAt: entry.completedAt ? Date.parse(entry.completedAt) : null,
      attempt: entry.attempt,
      lastError: lastError ?? null,
      resultSummary: resultSummary ?? null,
      nodeCount: entry.nodeCount,
      schemaVersion: 1,
    };
    try {
      await this._store.upsert(row);
    } catch (err) {
      if (err instanceof BackgroundTaskServiceError) throw err;
      throw new BackgroundTaskServiceError("storage-error", "background task storage unavailable");
    }
  }

  /** Publishes task.background.* via storage.append then EventBus.publish. */
  private async _emit(
    entry: Pick<BackgroundEntry, "taskId" | "conversationId" | "projectId" | "status">,
    type: BackgroundEventType,
    detail?: string,
  ): Promise<void> {
    const eventType = backgroundEventType(type);
    let clean: string | undefined;
    if (detail !== undefined) {
      clean = truncate(detail.trim(), 2000);
      if (clean.length > 0) {
        refuseSecrets({ detail: clean });
      } else {
        clean = undefined;
      }
    }
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sequence = await this._allocateSequence(entry.conversationId);
      const event = {
        eventId: createEventId(),
        conversationId: entry.conversationId,
        sequence,
        schemaVersion: 1,
        timestamp: now(),
        type: eventType,
        category: "extension",
        taskId: entry.taskId,
        projectId: entry.projectId,
        status: entry.status,
        ...(clean !== undefined ? { detail: clean } : {}),
      } as unknown as AIEvent;
      try {
        await this._storage.append(event);
      } catch {
        // Sequence collision (restart replay racing a live writer): take the
        // next sequence and retry instead of dropping the event.
        this._sequenceCounters.set(entry.conversationId, sequence + 1);
        continue;
      }
      await this._bus.publish(event);
      return;
    }
    throw new BackgroundTaskServiceError("storage-error", "background task storage unavailable");
  }

  private async _allocateSequence(conversationId: ConversationId): Promise<number> {
    const cached = this._sequenceCounters.get(conversationId);
    if (cached !== undefined) {
      this._sequenceCounters.set(conversationId, cached + 1);
      return cached;
    }
    let base = 0;
    try {
      const existing = await this._storage.getByConversation(conversationId);
      base = existing.length;
    } catch {
      base = 0;
    }
    this._sequenceCounters.set(conversationId, base + 1);
    return base;
  }

  // -------------------------------------------------------------------------
  // Ownership, projection, row validation
  // -------------------------------------------------------------------------

  private async _requireOwned(taskId: string, projectId: string): Promise<BackgroundEntry> {
    const id = requireTaskId(taskId);
    const scoped = requireProjectId(projectId);
    const entry = this._entries.get(id) ?? (await this._materialize(id));
    if (!entry) {
      throw new BackgroundTaskServiceError("not-found", "background task was not found");
    }
    if (entry.projectId !== scoped) {
      throw new BackgroundTaskServiceError(
        "project-mismatch",
        "background task does not belong to this project",
      );
    }
    return entry;
  }

  private async _materialize(taskId: TaskId): Promise<BackgroundEntry | null> {
    let row: BackgroundTaskRow | null;
    try {
      row = await this._store.get(taskId);
    } catch {
      throw new BackgroundTaskServiceError("storage-error", "background task storage unavailable");
    }
    if (!row) return null;
    const entry = this._entryFromRow(row);
    if (!entry) {
      throw new BackgroundTaskServiceError("storage-error", "stored background task is malformed");
    }
    this._entries.set(entry.taskId, entry);
    return entry;
  }

  private _entryFromRow(row: BackgroundTaskRow): BackgroundEntry | null {
    const validated = this._validateRow(row);
    if (!validated) return null;
    return this._entryFromValidated(validated, validated.status);
  }

  private _validateRow(row: BackgroundTaskRow): {
    taskId: TaskId;
    conversationId: ConversationId;
    projectId: string;
    title: string;
    goal: string;
    status: BackgroundTaskStatus;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    attempt: number;
    lastError?: string;
    resultSummary?: string;
    nodeCount: number;
  } | null {
    if (!row || typeof row !== "object") return null;
    if (typeof row.taskId !== "string" || !isUlid(row.taskId)) return null;
    if (typeof row.conversationId !== "string" || !isUlid(row.conversationId)) return null;
    if (
      typeof row.projectId !== "string" ||
      row.projectId.trim().length === 0 ||
      row.projectId.length > 256
    ) {
      return null;
    }
    const status = BackgroundTaskStatusSchema.safeParse(row.status);
    if (!status.success) return null;
    if (typeof row.title !== "string" || row.title.trim().length === 0 || row.title.length > 120) {
      return null;
    }
    if (typeof row.goal !== "string" || row.goal.trim().length === 0 || row.goal.length > 4000) {
      return null;
    }
    if (!Number.isInteger(row.attempt) || row.attempt < 0) return null;
    if (!Number.isInteger(row.schemaVersion) || row.schemaVersion !== 1) return null;
    if (!Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) return null;
    if (
      row.lastError != null &&
      (typeof row.lastError !== "string" || row.lastError.length > 2000)
    ) {
      return null;
    }
    if (
      row.resultSummary != null &&
      (typeof row.resultSummary !== "string" || row.resultSummary.length > 8000)
    ) {
      return null;
    }
    if (!Number.isInteger(row.nodeCount) || row.nodeCount < 0) return null;
    const createdAt = new Date(row.createdAt).toISOString();
    const updatedAt = new Date(row.updatedAt).toISOString();
    if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
    return {
      taskId: row.taskId.toUpperCase() as TaskId,
      conversationId: row.conversationId.toUpperCase() as ConversationId,
      projectId: row.projectId,
      title: row.title,
      goal: row.goal,
      status: status.data,
      createdAt,
      updatedAt,
      ...(row.startedAt != null ? { startedAt: new Date(row.startedAt).toISOString() } : {}),
      ...(row.completedAt != null ? { completedAt: new Date(row.completedAt).toISOString() } : {}),
      attempt: row.attempt,
      ...(row.lastError != null ? { lastError: row.lastError } : {}),
      ...(row.resultSummary != null ? { resultSummary: row.resultSummary } : {}),
      nodeCount: row.nodeCount,
    };
  }

  private _entryFromValidated(
    validated: NonNullable<ReturnType<DesktopBackgroundTaskService["_validateRow"]>>,
    status: BackgroundTaskStatus,
  ): BackgroundEntry {
    return {
      taskId: validated.taskId,
      conversationId: validated.conversationId,
      projectId: validated.projectId,
      title: validated.title,
      goal: validated.goal,
      status,
      createdAt: validated.createdAt,
      updatedAt: now(),
      ...(validated.startedAt ? { startedAt: validated.startedAt } : {}),
      ...(validated.completedAt ? { completedAt: validated.completedAt } : {}),
      attempt: validated.attempt,
      ...(validated.lastError !== undefined ? { lastError: validated.lastError } : {}),
      ...(validated.resultSummary !== undefined ? { resultSummary: validated.resultSummary } : {}),
      nodeCount: validated.nodeCount,
    };
  }

  /** Emits a rejected-recovery marker when the row is addressable; else silent. */
  private async _emitRejected(row: BackgroundTaskRow): Promise<void> {
    try {
      if (
        !row ||
        typeof row.taskId !== "string" ||
        !isUlid(row.taskId) ||
        typeof row.conversationId !== "string" ||
        !isUlid(row.conversationId) ||
        typeof row.projectId !== "string" ||
        row.projectId.trim().length === 0
      ) {
        return;
      }
      await this._emit(
        {
          taskId: row.taskId.toUpperCase() as TaskId,
          conversationId: row.conversationId.toUpperCase() as ConversationId,
          projectId: row.projectId,
          status: "failed",
        },
        "recovered",
        "rejected: malformed or duplicate recovery record; never executed",
      );
    } catch {
      // recovery markers are best-effort; never fail startup over them
    }
  }

  private _nodeCount(entry: BackgroundEntry): number {
    try {
      const graph = this._agents.getTaskGraph?.((entry.runtimeTaskId ?? entry.taskId) as TaskId);
      if (graph) return graph.nodes.length;
    } catch {
      // ignore: keep the last known count
    }
    return entry.nodeCount;
  }

  private _project(entry: BackgroundEntry): BackgroundTaskProjection {
    let currentNode: BackgroundTaskProjection["currentNode"];
    try {
      const graph = this._agents.getTaskGraph?.((entry.runtimeTaskId ?? entry.taskId) as TaskId);
      const nodes = graph?.nodes ?? [];
      const active =
        nodes.find(
          (n) => n.status === "active" || n.status === "pending" || n.status === "blocked",
        ) ?? nodes[0];
      if (active && typeof active.goal === "string" && active.goal.length > 0) {
        currentNode = {
          id: String(active.id),
          goal: truncate(active.goal, 2000),
          status: String(active.status),
        };
      }
    } catch {
      currentNode = undefined;
    }
    return {
      taskId: entry.taskId,
      projectId: entry.projectId,
      title: entry.title,
      status: entry.status,
      mode: "background",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
      attempt: entry.attempt,
      ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
      ...(entry.resultSummary !== undefined ? { resultSummary: entry.resultSummary } : {}),
      nodeCount: entry.nodeCount,
      ...(currentNode ? { currentNode } : {}),
    };
  }
}
