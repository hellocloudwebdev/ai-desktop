// PR43: packages/agent-runtime — BackgroundTaskManager (CORE thin orchestration)
//
// Thin orchestration layer over an injected AgentRuntime-like delegate.
// The manager owns presentation/lifecycle only (queued/running/paused/…):
//   - Execution mode foreground vs background is presentation/lifecycle only.
//     Both delegate to the SAME runtime.runTask — the manager never copies the
//     ReAct loop, never creates a BackgroundToolExecutor, second EventBus,
//     second permission system, or second memory.
//   - Retry: the manager implements NO retry of its own; the delegate runtime
//     already retries eligible transient failures once (MAX_AUTO_RETRIES=1).
//     `attempt` counts scheduling attempts only (incremented per launch).
//
// Exactly-once limitation (persisted intent ≠ external side effect):
//   Persistence records intent, not external side effects. A crash between a
//   tool call and its event commit leaves uncertainty: the record may say
//   `running` while the side effect already happened. Therefore this manager:
//     - Never auto-replays non-idempotent tools on recovery.
//     - Surfaces uncertain operations as `requires_approval`, never `resumable`.
//     - Reserves `resumable` for fresh (attempt <= 1) queued/running tasks whose
//       first replay is still idempotent-safe by construction.
//     - Never auto-executes tool side effects inside recover(): recovery only
//       requeues/restores snapshots; actual runs happen via schedule() on a
//       later explicit start/resume.
//
// Concurrency model (ai-core caps):
//   - Active (holds a worker slot): running | waiting_permission |
//     waiting_input | cancelling. Paused does NOT hold a slot; queued never
//     holds a slot; terminal (completed/failed/cancelled) holds nothing.
//   - Global cap MAX_BACKGROUND_TASKS, per-project cap
//     MAX_BACKGROUND_TASKS_PER_PROJECT. When caps hit, start() keeps the task
//     `queued` (emits task.background.queued) instead of erroring.
//   - FIFO dequeue: when a slot frees, the oldest queued entry launches first.
//   - Queue bound MAX_BACKGROUND_QUEUE counts queued entries; overflow while
//     the task would need to queue surfaces { code: 'queue-full' }.
//   - No distributed queue: single in-process Map + insertion-order FIFO.
//
// Cancellation / pause propagation (downward only, idempotent):
//   - cancel() propagates downward once (delegate.cancelTask best-effort +
//     AbortController.abort); siblings are never touched; second cancel returns
//     the same cancelled record without throwing or re-emitting.
//   - pause() never forces a delegate abort: it sets pauseRequested and lets
//     the in-flight turn settle. Late settlement while paused is ignored (the
//     entry stays paused); resume() re-enters the scheduler with a fresh
//     attempt. Paused frees its worker slot immediately.
//
// Security:
//   - assertNoSecrets on every persisted string (goal/title/systemPrompt,
//     cancel reasons, input responses, recovered payloads). Failures surface
//     { code: 'secret-refused' } and are never persisted.
//   - Truncation to ai-core bounds (title 120, input 2000, error 2000,
//     result 8000) before persistence/projection.
//   - taskId collisions are rejected; corrupted state never executes.
//   - get()/ops never throw on weird strings: malformed ids yield
//     { code: 'validation-error' }; unknown ids yield { code: 'not-found' };
//     cross-project access yields { code: 'project-mismatch' }.
//   - Prototype-pollution guard: `__proto__`/`constructor`/`prototype` ids and
//     overlong ids (>256) are validation errors; state lives in a Map.
//
// Zero Electron, Prisma, child process spawn, fs, or network imports.

import {
  assertNoSecrets,
  backgroundEventType,
  classifyRecovery,
  createEventId,
  isLegalBackgroundTransition,
  toBackgroundError,
  BackgroundTaskInputSchema,
  BackgroundTaskRecordSchema,
  MAX_BACKGROUND_ERROR_LENGTH,
  MAX_BACKGROUND_INPUT_LENGTH,
  MAX_BACKGROUND_QUEUE,
  MAX_BACKGROUND_RESULT_LENGTH,
  MAX_BACKGROUND_TASKS,
  MAX_BACKGROUND_TASKS_PER_PROJECT,
  MAX_BACKGROUND_TITLE_LENGTH,
  type BackgroundEventType,
  type BackgroundTaskError,
  type BackgroundTaskProjection,
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
} from "@ai-desktop/ai-core";
import {
  createConversationId,
  createTaskId,
  isUlid,
  type ConversationId,
  type TaskId,
} from "@ai-desktop/shared";
import type { AgentTaskResult, AgentTaskStatus, EventSink, RunTaskInput } from "./types.js";
import type { AIEvent } from "@ai-desktop/ai-core";

// ---------------------------------------------------------------------------
// Minimal delegate (structural Pick of AgentRuntime — avoids circular import)
// ---------------------------------------------------------------------------

/** Minimal runtime surface the manager delegates execution to. */
export interface BackgroundRuntimeDelegate {
  runTask(input: RunTaskInput, signal?: AbortSignal): Promise<AgentTaskResult>;
  cancelTask(taskId: TaskId): boolean;
  resumeTask(taskId: TaskId): Promise<AgentTaskResult | null>;
  getTaskStatus(taskId: TaskId): AgentTaskStatus | undefined;
  getTaskGraph(taskId: TaskId): unknown;
  listTasks(): TaskId[];
}

export interface BackgroundTaskManagerOptions {
  readonly runtime: BackgroundRuntimeDelegate;
  readonly eventSink?: EventSink;
  readonly now?: () => number;
  readonly createIds?: () => { taskId: TaskId; conversationId: ConversationId };
  readonly maxTasks?: number;
  readonly maxPerProject?: number;
  readonly maxQueue?: number;
  readonly onPersist?: (record: BackgroundTaskRecord) => void | Promise<void>;
}

export type BackgroundManagerOk = { readonly record: BackgroundTaskRecord };
export type BackgroundManagerErr = { readonly error: BackgroundTaskError };
export type BackgroundManagerResult = BackgroundManagerOk | BackgroundManagerErr;

export function isBackgroundManagerError(
  result: BackgroundManagerResult | { readonly entry: BackgroundEntry } | unknown,
): result is BackgroundManagerErr {
  return typeof result === "object" && result !== null && "error" in result;
}

export interface BackgroundRecoverSummary {
  readonly resumed: number;
  readonly awaitingApproval: number;
  readonly abandoned: number;
  readonly rejected: number;
}

interface BackgroundEntry {
  record: BackgroundTaskRecord;
  /** Immutable project binding captured at start; every op re-checks it. */
  projectId: string;
  abortController: AbortController;
  pauseRequested: boolean;
  cancelRequested: boolean;
  pendingPermission: boolean;
  pendingInput: boolean;
  modelId?: string;
  systemPrompt?: string;
  maxNodeIterations?: number;
  runtimeTaskId?: TaskId;
  /** True once the underlying run settled or the entry reached terminal. */
  settled: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  "running",
  "waiting_permission",
  "waiting_input",
  "cancelling",
]);

const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const DANGEROUS_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function toIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export class BackgroundTaskManager {
  private readonly _runtime: BackgroundRuntimeDelegate;
  private readonly _eventSink?: EventSink;
  private readonly _now: () => number;
  private readonly _createIds: () => { taskId: TaskId; conversationId: ConversationId };
  private readonly _maxTasks: number;
  private readonly _maxPerProject: number;
  private readonly _maxQueue: number;
  private readonly _onPersist?: (record: BackgroundTaskRecord) => void | Promise<void>;
  private readonly _entries = new Map<string, BackgroundEntry>();
  private _sequence = 0;

  constructor(options: BackgroundTaskManagerOptions) {
    if (!options || !options.runtime) {
      throw new TypeError("BackgroundTaskManager requires a runtime delegate");
    }
    this._runtime = options.runtime;
    this._eventSink = options.eventSink;
    this._now = options.now ?? Date.now;
    this._createIds =
      options.createIds ??
      (() => ({ taskId: createTaskId(), conversationId: createConversationId() }));
    this._maxTasks = options.maxTasks ?? MAX_BACKGROUND_TASKS;
    this._maxPerProject = options.maxPerProject ?? MAX_BACKGROUND_TASKS_PER_PROJECT;
    this._maxQueue = options.maxQueue ?? MAX_BACKGROUND_QUEUE;
    this._onPersist = options.onPersist;
  }

  // -------------------------------------------------------------------------
  // Introspection (for tests / desktop layer)
  // -------------------------------------------------------------------------

  get maxTasks(): number {
    return this._maxTasks;
  }

  get maxPerProject(): number {
    return this._maxPerProject;
  }

  get maxQueue(): number {
    return this._maxQueue;
  }

  get size(): number {
    return this._entries.size;
  }

  activeCount(): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (ACTIVE_STATUSES.has(entry.record.status)) count += 1;
    }
    return count;
  }

  activeCountForProject(projectId: string): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.projectId === projectId && ACTIVE_STATUSES.has(entry.record.status)) count += 1;
    }
    return count;
  }

  queuedCount(): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.record.status === "queued") count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Lifecycle ops
  // -------------------------------------------------------------------------

  /**
   * Starts a background task. Validates input, binds an immutable projectId,
   * emits queued, and launches immediately when a worker slot is free
   * (otherwise the record stays queued for FIFO scheduling).
   */
  async start(input: unknown): Promise<BackgroundManagerResult> {
    const parsed = BackgroundTaskInputSchema.safeParse(input);
    if (!parsed.success) {
      return { error: toBackgroundError("validation-error", "Invalid background task input") };
    }
    const value = parsed.data;
    try {
      assertNoSecrets(value.goal);
      if (value.title !== undefined) assertNoSecrets(value.title);
      if (value.systemPrompt !== undefined) assertNoSecrets(value.systemPrompt);
    } catch {
      return {
        error: toBackgroundError(
          "secret-refused",
          "secret-refused: input appears to contain secret material",
        ),
      };
    }

    const projectId = value.projectId.trim();
    if (DANGEROUS_IDS.has(projectId)) {
      return { error: toBackgroundError("validation-error", "Invalid projectId") };
    }

    // Queue bound applies when the task would need to queue (caps hit).
    if (!this._canLaunch(projectId) && this.queuedCount() >= this._maxQueue) {
      return { error: toBackgroundError("queue-full", "Background task queue is full") };
    }

    const ids = this._createIds();
    const taskKey = ids.taskId as string;
    if (this._entries.has(taskKey)) {
      return { error: toBackgroundError("task-active", "Background taskId collision") };
    }

    const nowIso = toIso(this._now());
    const title = truncate(
      (value.title ?? value.goal).trim().slice(0, MAX_BACKGROUND_TITLE_LENGTH) || "Background task",
      MAX_BACKGROUND_TITLE_LENGTH,
    );
    const goal = truncate(value.goal.trim(), 4000);
    const record: BackgroundTaskRecord = {
      taskId: ids.taskId,
      conversationId: value.conversationId ?? ids.conversationId,
      projectId,
      title,
      goal,
      mode: "background",
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      attempt: 0,
      schemaVersion: 1,
    };

    const entry: BackgroundEntry = {
      record,
      projectId,
      abortController: new AbortController(),
      pauseRequested: false,
      cancelRequested: false,
      pendingPermission: false,
      pendingInput: false,
      modelId: value.modelId,
      systemPrompt: value.systemPrompt,
      maxNodeIterations: value.maxNodeIterations,
      settled: false,
    };
    this._entries.set(taskKey, entry);
    await this._emit(entry, "queued", `Background task queued: ${truncate(title, 200)}`);
    await this._persist(entry);

    this._schedule();
    return { record: { ...entry.record } };
  }

  /**
   * Pauses a running/waiting task. Never forces a delegate abort: sets
   * pauseRequested and lets the in-flight turn settle. Frees the worker slot.
   */
  async pause(taskId: unknown, projectId: string): Promise<BackgroundManagerResult> {
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;
    if (entry.record.status === "paused") {
      return { record: { ...entry.record } };
    }
    if (
      TERMINAL_STATUSES.has(entry.record.status) ||
      entry.record.status === "queued" ||
      entry.record.status === "cancelling"
    ) {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot pause task in status "${entry.record.status}"`,
        ),
      };
    }
    if (!isLegalBackgroundTransition(entry.record.status, "paused")) {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot pause task in status "${entry.record.status}"`,
        ),
      };
    }
    entry.record = { ...entry.record, status: "paused", updatedAt: toIso(this._now()) };
    entry.pauseRequested = true;
    await this._emit(
      entry,
      "paused",
      "Background task paused; in-flight turn settles without abort.",
    );
    await this._persist(entry);
    this._schedule();
    return { record: { ...entry.record } };
  }

  /**
   * Resumes a paused task via queued (re-enters the scheduler). Waiting
   * states resume only via respondInput/notifyPermissionResolved, never here.
   */
  async resume(taskId: unknown, projectId: string): Promise<BackgroundManagerResult> {
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;
    if (entry.record.status !== "paused") {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot resume task in status "${entry.record.status}"`,
        ),
      };
    }
    if (!isLegalBackgroundTransition("paused", "queued")) {
      return { error: toBackgroundError("invalid-transition", "Cannot resume task") };
    }
    entry.record = { ...entry.record, status: "queued", updatedAt: toIso(this._now()) };
    entry.pauseRequested = false;
    await this._emit(entry, "resumed", "Background task resumed to queue.");
    await this._persist(entry);
    this._schedule();
    return { record: { ...entry.record } };
  }

  /**
   * Cancels a task. queued to cancelled directly; running via cancelling;
   * waiting states and paused go directly to cancelled (waiting to
   * cancelling is illegal per ai-core transitions). Downward intent propagates once (delegate
   * cancelTask best-effort + AbortController.abort). Idempotent.
   */
  async cancel(
    taskId: unknown,
    projectId: string,
    reason?: string,
  ): Promise<BackgroundManagerResult> {
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;

    if (entry.record.status === "cancelled") {
      return { record: { ...entry.record } };
    }
    if (TERMINAL_STATUSES.has(entry.record.status)) {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot cancel terminal task in status "${entry.record.status}"`,
        ),
      };
    }

    let detail: string | undefined;
    if (reason !== undefined) {
      if (typeof reason !== "string") {
        return { error: toBackgroundError("validation-error", "Cancel reason must be a string") };
      }
      try {
        assertNoSecrets(reason);
      } catch {
        return {
          error: toBackgroundError(
            "secret-refused",
            "secret-refused: cancel reason appears to contain secret material",
          ),
        };
      }
      detail = truncate(
        reason.trim().slice(0, MAX_BACKGROUND_ERROR_LENGTH),
        MAX_BACKGROUND_ERROR_LENGTH,
      );
    }

    const nowIso = toIso(this._now());
    const persistError = detail && detail.length > 0 ? detail : undefined;

    if (entry.record.status === "queued") {
      if (!isLegalBackgroundTransition("queued", "cancelled")) {
        return { error: toBackgroundError("invalid-transition", "Cannot cancel queued task") };
      }
      entry.record = {
        ...entry.record,
        status: "cancelled",
        updatedAt: nowIso,
        completedAt: nowIso,
        ...(persistError !== undefined ? { lastError: persistError } : {}),
      };
      entry.cancelRequested = true;
      entry.settled = true;
      await this._emit(entry, "cancelled", detail ?? "Background task cancelled while queued.");
      await this._persist(entry);
      this._schedule();
      return { record: { ...entry.record } };
    }

    if (entry.record.status === "running") {
      if (!isLegalBackgroundTransition("running", "cancelling")) {
        return { error: toBackgroundError("invalid-transition", "Cannot cancel running task") };
      }
      entry.record = { ...entry.record, status: "cancelling", updatedAt: nowIso };
      entry.cancelRequested = true;
      this._propagateCancel(entry);
      if (!isLegalBackgroundTransition("cancelling", "cancelled")) {
        return { error: toBackgroundError("invalid-transition", "Cannot cancel task") };
      }
      entry.record = {
        ...entry.record,
        status: "cancelled",
        updatedAt: toIso(this._now()),
        completedAt: toIso(this._now()),
        ...(persistError !== undefined ? { lastError: persistError } : {}),
      };
      entry.settled = true;
      await this._emit(entry, "cancelled", detail ?? "Background task cancelled.");
      await this._persist(entry);
      this._schedule();
      return { record: { ...entry.record } };
    }

    // waiting_permission / waiting_input / paused / cancelling → cancelled
    const from = entry.record.status;
    const canDirect =
      from === "waiting_permission" ||
      from === "waiting_input" ||
      from === "paused" ||
      from === "cancelling";
    if (!canDirect || !isLegalBackgroundTransition(from, "cancelled")) {
      return {
        error: toBackgroundError("invalid-transition", `Cannot cancel task in status "${from}"`),
      };
    }
    entry.cancelRequested = true;
    this._propagateCancel(entry);
    entry.record = {
      ...entry.record,
      status: "cancelled",
      updatedAt: toIso(this._now()),
      completedAt: toIso(this._now()),
      ...(persistError !== undefined ? { lastError: persistError } : {}),
    };
    entry.settled = true;
    await this._emit(entry, "cancelled", detail ?? "Background task cancelled.");
    await this._persist(entry);
    this._schedule();
    return { record: { ...entry.record } };
  }

  /** Unparks waiting_input → running. Validates length and secrets. */
  async respondInput(
    taskId: unknown,
    projectId: string,
    response: unknown,
  ): Promise<BackgroundManagerResult> {
    if (typeof response !== "string") {
      return { error: toBackgroundError("validation-error", "Input response must be a string") };
    }
    const trimmed = response.trim();
    if (trimmed.length === 0) {
      return { error: toBackgroundError("validation-error", "Input response must be non-empty") };
    }
    if (trimmed.length > MAX_BACKGROUND_INPUT_LENGTH) {
      return { error: toBackgroundError("validation-error", "Input response exceeds 2000 chars") };
    }
    try {
      assertNoSecrets(trimmed);
    } catch {
      return {
        error: toBackgroundError(
          "secret-refused",
          "secret-refused: input response appears to contain secret material",
        ),
      };
    }
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;
    if (entry.record.status !== "waiting_input") {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot respond to input in status "${entry.record.status}"`,
        ),
      };
    }
    if (!isLegalBackgroundTransition("waiting_input", "running")) {
      return { error: toBackgroundError("invalid-transition", "Cannot resume input wait") };
    }
    entry.record = { ...entry.record, status: "running", updatedAt: toIso(this._now()) };
    entry.pendingInput = false;
    await this._emit(entry, "resumed", "Input received; background task resumed.");
    await this._persist(entry);
    // Best-effort unblock of the delegate without executing new side effects
    // here; the desktop layer owns any further approval-gated continuation.
    try {
      const target = entry.runtimeTaskId ?? entry.record.taskId;
      await this._runtime.resumeTask(target);
    } catch {
      // ignore: manager state already unparked
    }
    return { record: { ...entry.record } };
  }

  /** Parks running → waiting_permission. No auto-approval is performed. */
  async notifyPermissionWaiting(
    taskId: unknown,
    projectId: string,
    detail?: string,
  ): Promise<BackgroundManagerResult> {
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;
    if (entry.record.status === "waiting_permission") {
      return { record: { ...entry.record } };
    }
    if (entry.record.status !== "running") {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot park permission wait in status "${entry.record.status}"`,
        ),
      };
    }
    if (!isLegalBackgroundTransition("running", "waiting_permission")) {
      return { error: toBackgroundError("invalid-transition", "Cannot park permission wait") };
    }
    if (detail !== undefined) {
      if (typeof detail !== "string") {
        return { error: toBackgroundError("validation-error", "Detail must be a string") };
      }
      try {
        assertNoSecrets(detail);
      } catch {
        return {
          error: toBackgroundError(
            "secret-refused",
            "secret-refused: detail appears to contain secret material",
          ),
        };
      }
    }
    entry.record = { ...entry.record, status: "waiting_permission", updatedAt: toIso(this._now()) };
    entry.pendingPermission = true;
    await this._emit(
      entry,
      "waiting_permission",
      detail !== undefined
        ? truncate(detail.trim().slice(0, 2000), 2000)
        : "Awaiting permission approval; no auto-approval.",
    );
    await this._persist(entry);
    return { record: { ...entry.record } };
  }

  /**
   * Unparks waiting_permission → running. Emits resumed. Performs NO
   * auto-approval: the desktop layer must approve via PermissionManager
   * separately; this only clears the manager-level park.
   */
  async notifyPermissionResolved(
    taskId: unknown,
    projectId: string,
    detail?: string,
  ): Promise<BackgroundManagerResult> {
    const found = this._lookup(taskId, projectId);
    if (isBackgroundManagerError(found)) return found;
    const entry = found.entry;
    if (entry.record.status !== "waiting_permission") {
      return {
        error: toBackgroundError(
          "invalid-transition",
          `Cannot resolve permission wait in status "${entry.record.status}"`,
        ),
      };
    }
    if (!isLegalBackgroundTransition("waiting_permission", "running")) {
      return { error: toBackgroundError("invalid-transition", "Cannot resolve permission wait") };
    }
    if (detail !== undefined) {
      if (typeof detail !== "string") {
        return { error: toBackgroundError("validation-error", "Detail must be a string") };
      }
      try {
        assertNoSecrets(detail);
      } catch {
        return {
          error: toBackgroundError(
            "secret-refused",
            "secret-refused: detail appears to contain secret material",
          ),
        };
      }
    }
    entry.record = { ...entry.record, status: "running", updatedAt: toIso(this._now()) };
    entry.pendingPermission = false;
    await this._emit(
      entry,
      "resumed",
      detail !== undefined
        ? truncate(detail.trim().slice(0, 2000), 2000)
        : "Permission wait cleared; task resumed.",
    );
    await this._persist(entry);
    return { record: { ...entry.record } };
  }

  /** Project-scoped fetch. Never throws on weird strings. */
  get(taskId: unknown, projectId?: string): BackgroundManagerResult {
    const idCheck = validateTaskId(taskId);
    if ("error" in idCheck) return { error: idCheck.error };
    const entry = this._entries.get(idCheck.taskId as string);
    if (!entry) {
      return { error: toBackgroundError("not-found", "Background task not found") };
    }
    if (projectId !== undefined) {
      if (
        typeof projectId !== "string" ||
        projectId.trim().length === 0 ||
        projectId.length > 256
      ) {
        return { error: toBackgroundError("validation-error", "Invalid projectId") };
      }
      if (DANGEROUS_IDS.has(projectId)) {
        return { error: toBackgroundError("validation-error", "Invalid projectId") };
      }
      if (entry.projectId !== projectId) {
        return { error: toBackgroundError("project-mismatch", "Background task project mismatch") };
      }
    }
    return { record: { ...entry.record } };
  }

  /** Renderer-safe projections (no graph internals, no secrets, bounded). */
  list(projectId?: string): BackgroundTaskProjection[] {
    const out: BackgroundTaskProjection[] = [];
    for (const entry of this._entries.values()) {
      if (projectId !== undefined && entry.projectId !== projectId) continue;
      out.push(toProjection(entry.record));
    }
    return out;
  }

  /**
   * Restores persisted records after a crash/restart. Never auto-executes
   * tool side effects: resumable entries are requeued as `queued` (a later
   * explicit schedule/start/resume performs the actual run); uncertain
   * entries are restored as paused/waiting snapshots for user action;
   * terminal entries are ignored. Idempotent: re-running with the same input
   * yields the same summary without duplicating entries or re-emitting.
   */
  async recover(persisted: unknown): Promise<BackgroundRecoverSummary> {
    const summary = { resumed: 0, awaitingApproval: 0, abandoned: 0, rejected: 0 };
    if (!Array.isArray(persisted)) {
      return { ...summary };
    }
    const seenInBatch = new Set<string>();
    for (const raw of persisted) {
      const parsed = BackgroundTaskRecordSchema.safeParse(raw);
      if (!parsed.success) {
        summary.rejected += 1;
        continue;
      }
      const rec = parsed.data;
      const key = rec.taskId as string;
      if (seenInBatch.has(key)) {
        // Duplicate within the batch: keep first, count as rejected so the
        // summary stays total-preserving without executing anything.
        summary.rejected += 1;
        continue;
      }
      seenInBatch.add(key);
      try {
        assertNoSecrets(rec.title);
        assertNoSecrets(rec.goal);
        if (rec.lastError) assertNoSecrets(rec.lastError);
        if (rec.resultSummary) assertNoSecrets(rec.resultSummary);
      } catch {
        summary.rejected += 1;
        continue;
      }
      const disposition = classifyRecovery({ status: rec.status, attempt: rec.attempt ?? 0 });
      if (disposition === "abandoned") {
        summary.abandoned += 1;
        continue;
      }
      const existing = this._entries.get(key);
      if (existing) {
        // Idempotent replay: count in the same bucket, keep the first entry,
        // do not duplicate and do not re-emit.
        if (disposition === "resumable") summary.resumed += 1;
        else summary.awaitingApproval += 1;
        continue;
      }
      if (disposition === "resumable") {
        const restored: BackgroundTaskRecord = {
          ...rec,
          status: "queued",
          updatedAt: toIso(this._now()),
        };
        const entry: BackgroundEntry = {
          record: restored,
          projectId: restored.projectId,
          abortController: new AbortController(),
          pauseRequested: false,
          cancelRequested: false,
          pendingPermission: false,
          pendingInput: false,
          settled: false,
        };
        this._entries.set(key, entry);
        summary.resumed += 1;
        await this._emit(
          entry,
          "recovered",
          "Resumable task restored to queue; awaiting scheduler.",
        );
        await this._persist(entry);
        // Intentionally no _schedule() here: recovery never auto-executes.
      } else {
        let restoreStatus: BackgroundTaskStatus = rec.status;
        if (
          restoreStatus === "running" ||
          restoreStatus === "queued" ||
          restoreStatus === "cancelling"
        ) {
          restoreStatus = "paused";
        }
        const restored: BackgroundTaskRecord = {
          ...rec,
          status: restoreStatus,
          updatedAt: toIso(this._now()),
        };
        const entry: BackgroundEntry = {
          record: restored,
          projectId: restored.projectId,
          abortController: new AbortController(),
          pauseRequested: restoreStatus === "paused",
          cancelRequested: false,
          pendingPermission: restoreStatus === "waiting_permission",
          pendingInput: restoreStatus === "waiting_input",
          settled: false,
        };
        this._entries.set(key, entry);
        summary.awaitingApproval += 1;
        await this._emit(
          entry,
          "recovered",
          "Task requires approval before resuming; no side effects replayed.",
        );
        await this._persist(entry);
      }
    }
    return { ...summary };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _lookup(
    taskId: unknown,
    projectId: string,
  ): { entry: BackgroundEntry } | BackgroundManagerErr {
    const idCheck = validateTaskId(taskId);
    if ("error" in idCheck) return { error: idCheck.error };
    const entry = this._entries.get(idCheck.taskId as string);
    if (!entry) {
      return { error: toBackgroundError("not-found", "Background task not found") };
    }
    if (typeof projectId !== "string" || projectId.trim().length === 0 || projectId.length > 256) {
      return { error: toBackgroundError("validation-error", "Invalid projectId") };
    }
    if (DANGEROUS_IDS.has(projectId)) {
      return { error: toBackgroundError("validation-error", "Invalid projectId") };
    }
    if (entry.projectId !== projectId) {
      return { error: toBackgroundError("project-mismatch", "Background task project mismatch") };
    }
    return { entry };
  }

  private _canLaunch(projectId: string): boolean {
    if (this.activeCount() >= this._maxTasks) return false;
    if (this.activeCountForProject(projectId) >= this._maxPerProject) return false;
    return true;
  }

  /** FIFO: oldest queued first (Map preserves insertion order). */
  private _schedule(): void {
    for (const entry of [...this._entries.values()]) {
      if (entry.record.status !== "queued") continue;
      if (!this._canLaunch(entry.projectId)) continue;
      this._launch(entry);
    }
  }

  private _launch(entry: BackgroundEntry): void {
    if (entry.record.status !== "queued") return;
    if (!this._canLaunch(entry.projectId)) return;
    if (!isLegalBackgroundTransition("queued", "running")) return;
    const nowIso = toIso(this._now());
    entry.record = {
      ...entry.record,
      status: "running",
      updatedAt: nowIso,
      startedAt: entry.record.startedAt ?? nowIso,
      attempt: entry.record.attempt + 1,
    };
    entry.pauseRequested = false;
    entry.settled = false;
    entry.abortController = new AbortController();
    void this._emit(entry, "started", "Background task started.");
    void this._persist(entry);

    const input: RunTaskInput = {
      conversationId: entry.record.conversationId,
      goal: entry.record.goal,
      projectId: entry.projectId,
      ...(entry.modelId !== undefined ? { modelId: entry.modelId as RunTaskInput["modelId"] } : {}),
      ...(entry.systemPrompt !== undefined ? { systemPrompt: entry.systemPrompt } : {}),
      ...(entry.maxNodeIterations !== undefined
        ? { maxNodeIterations: entry.maxNodeIterations }
        : {}),
    };
    let promise: Promise<AgentTaskResult>;
    try {
      promise = this._runtime.runTask(input, entry.abortController.signal);
    } catch (err) {
      void this._handleLaunchThrow(entry, err);
      return;
    }
    void Promise.resolve(promise).then(
      (result) => {
        void this._handleRuntimeSettled(entry, result);
      },
      (err) => {
        void this._handleRuntimeRejected(entry, err);
      },
    );
  }

  private async _handleLaunchThrow(entry: BackgroundEntry, err: unknown): Promise<void> {
    if (entry.settled || TERMINAL_STATUSES.has(entry.record.status)) return;
    if (entry.record.status === "paused") {
      entry.settled = true;
      return;
    }
    const message = truncate(
      err instanceof Error ? err.message : String(err),
      MAX_BACKGROUND_ERROR_LENGTH,
    );
    if (!isLegalBackgroundTransition(entry.record.status, "failed")) return;
    const nowIso = toIso(this._now());
    entry.record = {
      ...entry.record,
      status: "failed",
      updatedAt: nowIso,
      completedAt: nowIso,
      lastError: safePersistError(message),
    };
    entry.settled = true;
    await this._emit(entry, "failed", message);
    await this._persist(entry);
    this._schedule();
  }

  private async _handleRuntimeSettled(
    entry: BackgroundEntry,
    result: AgentTaskResult,
  ): Promise<void> {
    if (entry.settled || TERMINAL_STATUSES.has(entry.record.status)) return;
    if (result.taskId) {
      entry.runtimeTaskId = result.taskId;
    }
    // Parked entries keep their park: late settlement is ignored (stays
    // paused/waiting) so pause/resume and approval gates stay authoritative.
    if (
      entry.record.status === "paused" ||
      entry.record.status === "waiting_permission" ||
      entry.record.status === "waiting_input"
    ) {
      entry.settled = true;
      return;
    }
    const nowIso = toIso(this._now());
    if (entry.record.status === "cancelling") {
      const terminal: BackgroundTaskStatus = result.status === "failed" ? "failed" : "cancelled";
      if (!isLegalBackgroundTransition("cancelling", terminal)) return;
      entry.record = {
        ...entry.record,
        status: terminal,
        updatedAt: nowIso,
        completedAt: nowIso,
        ...(terminal === "failed"
          ? {
              lastError: safePersistError(
                truncate(
                  result.status === "failed" ? result.error : "Task cancelled",
                  MAX_BACKGROUND_ERROR_LENGTH,
                ),
              ),
            }
          : {}),
      };
      entry.settled = true;
      await this._emit(
        entry,
        terminal === "failed" ? "failed" : "cancelled",
        terminal === "failed" ? entry.record.lastError : "Background task cancelled.",
      );
      await this._persist(entry);
      this._schedule();
      return;
    }
    if (entry.record.status !== "running") return;
    if (result.status === "completed") {
      if (!isLegalBackgroundTransition("running", "completed")) return;
      entry.record = {
        ...entry.record,
        status: "completed",
        updatedAt: nowIso,
        completedAt: nowIso,
        resultSummary: safePersistSummary(truncate(result.summary, MAX_BACKGROUND_RESULT_LENGTH)),
      };
      entry.settled = true;
      await this._emit(entry, "completed", "Background task completed.");
      await this._persist(entry);
      this._schedule();
      return;
    }
    if (result.status === "failed") {
      if (!isLegalBackgroundTransition("running", "failed")) return;
      entry.record = {
        ...entry.record,
        status: "failed",
        updatedAt: nowIso,
        completedAt: nowIso,
        lastError: safePersistError(truncate(result.error, MAX_BACKGROUND_ERROR_LENGTH)),
      };
      entry.settled = true;
      await this._emit(entry, "failed", entry.record.lastError);
      await this._persist(entry);
      this._schedule();
      return;
    }
    if (!isLegalBackgroundTransition("running", "cancelled")) return;
    entry.record = {
      ...entry.record,
      status: "cancelled",
      updatedAt: nowIso,
      completedAt: nowIso,
    };
    entry.settled = true;
    await this._emit(entry, "cancelled", result.reason ?? "Background task cancelled.");
    await this._persist(entry);
    this._schedule();
  }

  private async _handleRuntimeRejected(entry: BackgroundEntry, err: unknown): Promise<void> {
    if (entry.settled || TERMINAL_STATUSES.has(entry.record.status)) return;
    if (
      entry.record.status === "paused" ||
      entry.record.status === "waiting_permission" ||
      entry.record.status === "waiting_input"
    ) {
      entry.settled = true;
      return;
    }
    const message = truncate(
      err instanceof Error ? err.message : String(err),
      MAX_BACKGROUND_ERROR_LENGTH,
    );
    const cancelled = entry.cancelRequested || entry.abortController.signal.aborted;
    const terminal: BackgroundTaskStatus = cancelled ? "cancelled" : "failed";
    if (
      !isLegalBackgroundTransition(entry.record.status, terminal) &&
      !(entry.record.status === "cancelling" && (terminal === "cancelled" || terminal === "failed"))
    ) {
      return;
    }
    const nowIso = toIso(this._now());
    entry.record = {
      ...entry.record,
      status: terminal,
      updatedAt: nowIso,
      completedAt: nowIso,
      ...(terminal === "failed" ? { lastError: safePersistError(message) } : {}),
    };
    entry.settled = true;
    await this._emit(
      entry,
      terminal === "failed" ? "failed" : "cancelled",
      terminal === "failed" ? message : "Background task cancelled.",
    );
    await this._persist(entry);
    this._schedule();
  }

  private _propagateCancel(entry: BackgroundEntry): void {
    // Downward-only, exactly once: delegate cancel best-effort + signal abort.
    // Siblings are never touched; repeated cancels are guarded by settled/
    // cancelRequested so the delegate sees a single intent.
    if (entry.settled && entry.record.status === "cancelled") return;
    try {
      const target = entry.runtimeTaskId ?? entry.record.taskId;
      this._runtime.cancelTask(target);
    } catch {
      // ignore: abort below still carries the intent
    }
    try {
      entry.abortController.abort("Background task cancelled");
    } catch {
      // ignore
    }
  }

  private async _emit(
    entry: BackgroundEntry,
    type: BackgroundEventType,
    detail?: string,
  ): Promise<void> {
    if (!this._eventSink) return;
    try {
      const event = {
        eventId: createEventId(),
        conversationId: entry.record.conversationId,
        sequence: this._sequence++,
        schemaVersion: 1,
        timestamp: toIso(this._now()),
        type: backgroundEventType(type),
        category: "extension",
        taskId: entry.record.taskId,
        projectId: entry.projectId,
        status: entry.record.status,
        ...(detail !== undefined ? { detail: truncate(detail.trim().slice(0, 2000), 2000) } : {}),
      } as unknown as AIEvent;
      await this._eventSink.publish(event);
    } catch {
      // Event emission is best-effort; lifecycle state already advanced.
    }
  }

  private async _persist(entry: BackgroundEntry): Promise<void> {
    if (!this._onPersist) return;
    try {
      await this._onPersist({ ...entry.record });
    } catch {
      // Persistence intent failures never break lifecycle transitions.
    }
  }
}

function validateTaskId(taskId: unknown): { taskId: TaskId } | { error: BackgroundTaskError } {
  if (typeof taskId !== "string") {
    return { error: toBackgroundError("validation-error", "Invalid background taskId") };
  }
  if (taskId.length === 0 || taskId.length > 256) {
    return { error: toBackgroundError("validation-error", "Invalid background taskId") };
  }
  if (DANGEROUS_IDS.has(taskId)) {
    return { error: toBackgroundError("validation-error", "Invalid background taskId") };
  }
  // Guard against prototype pollution / control characters without throwing.
  if (taskId.includes("\0") || taskId.includes("\n") || taskId.includes("\r")) {
    return { error: toBackgroundError("validation-error", "Invalid background taskId") };
  }
  if (!isUlid(taskId)) {
    return { error: toBackgroundError("validation-error", "Invalid background taskId") };
  }
  return { taskId: taskId as TaskId };
}

function toProjection(record: BackgroundTaskRecord): BackgroundTaskProjection {
  return {
    taskId: record.taskId,
    projectId: record.projectId,
    title: truncate(record.title, MAX_BACKGROUND_TITLE_LENGTH),
    status: record.status,
    mode: "background",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    attempt: record.attempt,
    ...(record.lastError !== undefined
      ? { lastError: truncate(record.lastError, MAX_BACKGROUND_ERROR_LENGTH) }
      : {}),
    ...(record.resultSummary !== undefined
      ? { resultSummary: truncate(record.resultSummary, MAX_BACKGROUND_RESULT_LENGTH) }
      : {}),
    ...(record.nodeCount !== undefined ? { nodeCount: record.nodeCount } : {}),
  };
}

/**
 * Runtime-produced summaries/errors are redacted (never persisted raw) when
 * they trip the secret guard; completion itself still proceeds.
 */
function safePersistSummary(value: string): string {
  try {
    assertNoSecrets(value);
    return value;
  } catch {
    return "[redacted: secret-refused]";
  }
}

function safePersistError(value: string): string {
  try {
    assertNoSecrets(value);
    return value;
  } catch {
    return "[redacted: secret-refused]";
  }
}
