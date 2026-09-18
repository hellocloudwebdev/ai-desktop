// PR43: renderer — Background Task Center bridge + pure view helpers
//
// Narrow, renderer-safe access to the background-task IPC owned by the
// sibling agent (`window.api.backgroundTasks.{list,get,start,pause,resume,
// cancel,respond}`). The bridge is probed with optional chaining: when the
// sibling IPC has not landed yet (or on non-Electron hosts / tests without
// `window`), every accessor yields an empty result — never a crash — and
// `createLocalBackgroundTaskStub` provides an in-memory stand-in so the
// Task Center renders and the store/projection tests pass.
//
// Invariants:
//   1. Projections only: the renderer never touches runtime internals,
//      Node or Electron APIs, spawned processes, Prisma, or the DOM bridge
//      beyond `window.api`. Data arrives as
//      `BackgroundTaskProjection`-shaped views and leaves as narrow calls.
//   2. The renderer holds no source of truth: state re-queries the bridge
//      on mount / poll / scope change, so remounts and disconnects recover
//      by re-fetching.
//   3. Isolation is display-level: filtering by project never rewrites a
//      task's bound `projectId`; rows always render the bound id.
//   4. Hygiene at render: titles ≤120, errors ≤2000, results ≤8000 chars;
//      `key=value`-shaped secret material is redacted, never rendered raw.

import {
  BACKGROUND_EVENT_TYPES,
  type BackgroundTaskProjection,
  type BackgroundTaskStatus,
} from "@ai-desktop/ai-core";

// ---------------------------------------------------------------------------
// Status vocabulary (mirrors ai-core; renderer never redefines transitions)
// ---------------------------------------------------------------------------

/** Active section, in display priority order. */
export const BACKGROUND_ACTIVE_STATUSES: readonly BackgroundTaskStatus[] = [
  "running",
  "waiting_permission",
  "waiting_input",
  "queued",
  "paused",
  "cancelling",
] as const;

/** Completed section, in display priority order. */
export const BACKGROUND_COMPLETED_STATUSES: readonly BackgroundTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export function isActiveBackgroundStatus(status: string): boolean {
  return (BACKGROUND_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isCompletedBackgroundStatus(status: string): boolean {
  return (BACKGROUND_COMPLETED_STATUSES as readonly string[]).includes(status);
}

/** Display priority within the Active section (lower renders first). */
const ACTIVE_STATUS_ORDER: Record<string, number> = {
  running: 0,
  waiting_permission: 1,
  waiting_input: 2,
  queued: 3,
  paused: 4,
  cancelling: 5,
};

/** `task.background.*` transition names surfaced from EventBus/activity projections. */
export const BACKGROUND_ACTIVITY_EVENT_NAMES: readonly string[] = BACKGROUND_EVENT_TYPES.map(
  (type) => `task.background.${type}`,
);

// ---------------------------------------------------------------------------
// Renderer-safe view (projection subset; secrets never carried)
// ---------------------------------------------------------------------------

export interface BackgroundTaskCurrentNode {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
}

export interface BackgroundTaskView {
  readonly taskId: string;
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
  readonly currentNode?: BackgroundTaskCurrentNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isBackgroundStatus(value: unknown): value is BackgroundTaskStatus {
  return (
    typeof value === "string" &&
    ((BACKGROUND_ACTIVE_STATUSES as readonly string[]).includes(value) ||
      (BACKGROUND_COMPLETED_STATUSES as readonly string[]).includes(value))
  );
}

/**
 * Validates one unknown entry into a BackgroundTaskView, or null when
 * unusable. Foreground tasks (`mode !== "background"`) are rejected: the
 * Task Center never re-scopes foreground work into the background list.
 */
export function normalizeBackgroundTaskView(item: unknown): BackgroundTaskView | null {
  if (!isRecord(item)) return null;
  if (typeof item.taskId !== "string" || item.taskId.length === 0) return null;
  if (typeof item.projectId !== "string" || item.projectId.length === 0) return null;
  if (typeof item.title !== "string" || item.title.length === 0) return null;
  if (!isBackgroundStatus(item.status)) return null;
  if (item.mode !== undefined && item.mode !== "background") return null;
  if (typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") return null;
  let currentNode: BackgroundTaskCurrentNode | undefined;
  if (isRecord(item.currentNode)) {
    if (
      typeof item.currentNode.id === "string" &&
      typeof item.currentNode.goal === "string" &&
      typeof item.currentNode.status === "string"
    ) {
      currentNode = {
        id: item.currentNode.id,
        goal: item.currentNode.goal,
        status: item.currentNode.status,
      };
    }
  }
  return {
    taskId: item.taskId,
    projectId: item.projectId,
    title: item.title,
    status: item.status,
    mode: "background",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedAt: asOptionalString(item.startedAt),
    completedAt: asOptionalString(item.completedAt),
    attempt: typeof item.attempt === "number" && Number.isInteger(item.attempt) ? item.attempt : 0,
    lastError: asOptionalString(item.lastError),
    resultSummary: asOptionalString(item.resultSummary),
    nodeCount: asOptionalNonNegativeInt(item.nodeCount),
    ...(currentNode ? { currentNode } : {}),
  };
}

/** Normalizes a candidate list, dropping entries that fail validation. */
export function normalizeBackgroundTaskViews(items: readonly unknown[]): BackgroundTaskView[] {
  const views: BackgroundTaskView[] = [];
  for (const item of items) {
    const view = normalizeBackgroundTaskView(item);
    if (view) views.push(view);
  }
  return views;
}

function unwrapEnvelope(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.ok === true && "value" in raw) return raw.value;
  return raw;
}

/**
 * Accepts the list envelope (`{ ok, value: { tasks } }` / `{ ok, value: [...] }`)
 * or a raw array, and returns candidate entries. Anything else yields [].
 */
export function unwrapBackgroundTaskList(raw: unknown): unknown[] {
  const value = unwrapEnvelope(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.tasks)) return value.tasks;
  return [];
}

/** Accepts the get envelope (`{ ok, value: { task } }`) or a raw projection. */
export function unwrapBackgroundTask(raw: unknown): unknown {
  const value = unwrapEnvelope(raw);
  if (isRecord(value) && "task" in value) return value.task;
  return value;
}

// ---------------------------------------------------------------------------
// Grouping / filtering (pure; never mutates the bound projectId)
// ---------------------------------------------------------------------------

export interface GroupedBackgroundTasks {
  readonly active: BackgroundTaskView[];
  readonly completed: BackgroundTaskView[];
}

function compareUpdatedDesc(a: BackgroundTaskView, b: BackgroundTaskView): number {
  if (a.updatedAt === b.updatedAt) return a.taskId.localeCompare(b.taskId);
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/**
 * Splits projections into the Active section (Running, Waiting for
 * approval, Waiting for input, Queued, Paused, Cancelling) and the
 * Completed section (Completed/Failed/Cancelled). Unknown statuses are
 * dropped by normalization before they reach this function.
 */
export function groupBackgroundTasks(tasks: readonly BackgroundTaskView[]): GroupedBackgroundTasks {
  const active = tasks
    .filter((t) => isActiveBackgroundStatus(t.status))
    .sort(
      (a, b) =>
        ACTIVE_STATUS_ORDER[a.status] - ACTIVE_STATUS_ORDER[b.status] || compareUpdatedDesc(a, b),
    );
  const completed = tasks
    .filter((t) => isCompletedBackgroundStatus(t.status))
    .sort(compareUpdatedDesc);
  return { active, completed };
}

/**
 * Display-only project filter. Returns the tasks bound to `projectId`;
 * the bound `projectId` on each task is preserved untouched, so switching
 * projects never re-scopes a task.
 */
export function filterBackgroundTasksByProject(
  tasks: readonly BackgroundTaskView[],
  projectId: string,
): BackgroundTaskView[] {
  return tasks.filter((t) => t.projectId === projectId);
}

/** Counts tasks in the Active section (sidebar badge input). */
export function countActiveBackgroundTasks(tasks: readonly BackgroundTaskView[]): number {
  return tasks.filter((t) => isActiveBackgroundStatus(t.status)).length;
}

// ---------------------------------------------------------------------------
// Render hygiene: truncation + secret redaction + formatting
// ---------------------------------------------------------------------------

export const MAX_BACKGROUND_DISPLAY_TITLE = 120;
export const MAX_BACKGROUND_DISPLAY_ERROR = 2000;
export const MAX_BACKGROUND_DISPLAY_RESULT = 8000;
/** Maximum rows rendered per section; the list itself stays bounded. */
export const MAX_BACKGROUND_ROWS_PER_SECTION = 50;
/** Maximum timeline entries rendered in the detail view. */
export const MAX_BACKGROUND_TIMELINE_ITEMS = 100;

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function truncateTitle(value: string): string {
  return truncateText(value, MAX_BACKGROUND_DISPLAY_TITLE);
}

export function truncateErrorText(value: string): string {
  return truncateText(value, MAX_BACKGROUND_DISPLAY_ERROR);
}

export function truncateResultSummary(value: string): string {
  return truncateText(value, MAX_BACKGROUND_DISPLAY_RESULT);
}

/**
 * Redacts `key=value`-shaped secret material before render (API keys,
 * tokens, passwords, bearer credentials). Plain prose that merely mentions
 * these words (e.g. "token limit exceeded") passes through untouched —
 * only assignment-shaped fragments are withheld.
 */
export function redactSecretAssignments(value: string): string {
  return value
    .replace(/\b[Bb]earer\s+\S+/g, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|oauth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|(?!Bearer\b)\S+)/gi,
      "$1: [redacted]",
    );
}

/** Safe timestamp for display; malformed input renders as "—", never throws. */
export function formatBackgroundTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * Elapsed wall time between `startedAt` and `completedAt ?? nowMs`.
 * Returns "—" when the task never started. Pure (clock injectable).
 */
export function formatBackgroundDuration(task: BackgroundTaskView, nowMs?: number): string {
  if (!task.startedAt) return "—";
  const start = Date.parse(task.startedAt);
  if (Number.isNaN(start)) return "—";
  const endSource = task.completedAt ?? undefined;
  const end = endSource ? Date.parse(endSource) : (nowMs ?? Date.now());
  if (Number.isNaN(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const STATUS_BADGE_CLASSES: Record<BackgroundTaskStatus, string> = {
  running: "bg-indigo-800 text-indigo-100",
  queued: "bg-slate-700 text-slate-200",
  waiting_permission: "bg-orange-800 text-orange-100",
  waiting_input: "bg-amber-800 text-amber-100",
  paused: "bg-slate-700 text-slate-300",
  cancelling: "bg-rose-900/60 text-rose-200",
  completed: "bg-emerald-800 text-emerald-100",
  failed: "bg-rose-800 text-rose-100",
  cancelled: "bg-slate-700 text-slate-400",
};

export function backgroundStatusBadgeClass(status: BackgroundTaskStatus): string {
  return STATUS_BADGE_CLASSES[status] ?? "bg-slate-700 text-slate-200";
}

const STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  running: "Running",
  queued: "Queued",
  waiting_permission: "Waiting for approval",
  waiting_input: "Waiting for input",
  paused: "Paused",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function backgroundStatusLabel(status: BackgroundTaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// ---------------------------------------------------------------------------
// Narrow bridge client (`window.api.backgroundTasks.*`, optional)
// ---------------------------------------------------------------------------

/**
 * Expected narrow client interface for the sibling-owned background IPC.
 * Defined locally (not in shared) until the sibling's preload lands; the
 * probe below activates it automatically with no renderer change.
 */
export interface BackgroundTasksCommands {
  list(args?: { projectId?: string }): Promise<unknown>;
  get(args: { taskId: string }): Promise<unknown>;
  start(args: { projectId: string; title?: string; goal: string }): Promise<unknown>;
  pause(args: { taskId: string }): Promise<unknown>;
  resume(args: { taskId: string }): Promise<unknown>;
  cancel(args: { taskId: string }): Promise<unknown>;
  respond(args: { taskId: string; input: string }): Promise<unknown>;
}

const BACKGROUND_COMMAND_NAMES = [
  "list",
  "get",
  "start",
  "pause",
  "resume",
  "cancel",
  "respond",
] as const;

/**
 * Returns the sibling-owned background bridge when every expected method
 * is present, otherwise null. Never throws: a missing bridge is an
 * expected pre-landing state, not an error.
 */
export function getBackgroundTasksCommands(): BackgroundTasksCommands | null {
  try {
    if (typeof window === "undefined") return null;
    const api = window as unknown as {
      api?: { backgroundTasks?: Record<string, unknown> };
    };
    const bridge = api.api?.backgroundTasks;
    if (!bridge) return null;
    for (const name of BACKGROUND_COMMAND_NAMES) {
      if (typeof bridge[name] !== "function") return null;
    }
    return bridge as unknown as BackgroundTasksCommands;
  } catch {
    return null;
  }
}

/** Lists projections through the bridge. Absent bridge → []. */
export async function fetchBackgroundTaskList(
  commands: BackgroundTasksCommands | null,
  projectId?: string,
): Promise<BackgroundTaskView[]> {
  if (!commands) return [];
  const raw = await commands.list(projectId ? { projectId } : {});
  return normalizeBackgroundTaskViews(unwrapBackgroundTaskList(raw));
}

/** Fetches one projection. Absent bridge or unknown id → null. */
export async function fetchBackgroundTask(
  commands: BackgroundTasksCommands | null,
  taskId: string,
): Promise<BackgroundTaskView | null> {
  if (!commands) return null;
  const raw = await commands.get({ taskId });
  return normalizeBackgroundTaskView(unwrapBackgroundTask(raw));
}

export interface BackgroundCommandResult {
  readonly ok: boolean;
  readonly error: string | null;
}

function toCommandResult(raw: unknown, action: string): BackgroundCommandResult {
  if (isRecord(raw) && raw.ok === false) {
    const error = isRecord(raw.error)
      ? asOptionalString(raw.error.message)
      : asOptionalString(raw.error);
    return { ok: false, error: error ?? `${action} failed` };
  }
  return { ok: true, error: null };
}

async function runBridgeCommand(
  commands: BackgroundTasksCommands | null,
  action: string,
  invoke: (bridge: BackgroundTasksCommands) => Promise<unknown>,
): Promise<BackgroundCommandResult> {
  if (!commands) return { ok: false, error: "Background IPC is not available yet." };
  try {
    return toCommandResult(await invoke(commands), action);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${action} failed` };
  }
}

export function pauseBackgroundTask(
  commands: BackgroundTasksCommands | null,
  taskId: string,
): Promise<BackgroundCommandResult> {
  return runBridgeCommand(commands, "pause", (bridge) => bridge.pause({ taskId }));
}

export function resumeBackgroundTask(
  commands: BackgroundTasksCommands | null,
  taskId: string,
): Promise<BackgroundCommandResult> {
  return runBridgeCommand(commands, "resume", (bridge) => bridge.resume({ taskId }));
}

export function cancelBackgroundTask(
  commands: BackgroundTasksCommands | null,
  taskId: string,
): Promise<BackgroundCommandResult> {
  return runBridgeCommand(commands, "cancel", (bridge) => bridge.cancel({ taskId }));
}

/**
 * Answers a `waiting_input` task with free-text user input. This is data
 * for the task, never a permission decision: permission approval always
 * flows through the existing permission UI path (`resolvePermission`),
 * never through `respond`, and this module performs no auto-approval.
 */
export function respondBackgroundTask(
  commands: BackgroundTasksCommands | null,
  taskId: string,
  input: string,
): Promise<BackgroundCommandResult> {
  return runBridgeCommand(commands, "respond", (bridge) => bridge.respond({ taskId, input }));
}

// ---------------------------------------------------------------------------
// Local stub (pre-IPC stand-in; renderer-local only, never a source of truth)
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in implementing `BackgroundTasksCommands` with IPC-shaped
 * envelopes. Used when the sibling bridge is absent so the Task Center
 * renders an honest empty/disabled state and tests exercise the full
 * normalize → group → display pipeline. Production state always
 * re-queries the real bridge on mount, so stub contents never leak across
 * a real landing.
 */
export function createLocalBackgroundTaskStub(
  initial: readonly BackgroundTaskProjection[] = [],
): BackgroundTasksCommands & { seed(view: BackgroundTaskProjection): void } {
  const tasks = new Map<string, BackgroundTaskProjection>();
  for (const item of initial) {
    tasks.set(item.taskId, item);
  }
  const envelope = (value: unknown): unknown => ({ ok: true, value });
  const failure = (message: string): unknown => ({ ok: false, error: { message } });
  const legal: Record<string, readonly string[]> = {
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
  const transition = (taskId: string, to: BackgroundTaskStatus): unknown => {
    const current = tasks.get(taskId);
    if (!current) return failure(`not-found: ${taskId}`);
    const allowed = legal[current.status] ?? [];
    if (!(allowed as readonly string[]).includes(to)) {
      return failure(`invalid-transition: ${current.status} -> ${to}`);
    }
    const now = new Date().toISOString();
    const terminal = to === "completed" || to === "failed" || to === "cancelled";
    tasks.set(taskId, {
      ...current,
      status: to,
      updatedAt: now,
      ...(terminal ? { completedAt: now } : {}),
    });
    return envelope({ task: tasks.get(taskId) });
  };
  return {
    seed(view: BackgroundTaskProjection): void {
      tasks.set(view.taskId, view);
    },
    async list(args?: { projectId?: string }): Promise<unknown> {
      const all = [...tasks.values()];
      const filtered = args?.projectId ? all.filter((t) => t.projectId === args.projectId) : all;
      return envelope({ tasks: filtered });
    },
    async get(args: { taskId: string }): Promise<unknown> {
      const task = tasks.get(args.taskId);
      if (!task) return failure(`not-found: ${args.taskId}`);
      return envelope({ task });
    },
    async start(args: { projectId: string; title?: string; goal: string }): Promise<unknown> {
      const now = new Date().toISOString();
      const task: BackgroundTaskProjection = {
        taskId:
          `01STUB${String(tasks.size).padStart(4, "0")}000000000000` as BackgroundTaskProjection["taskId"],
        projectId: args.projectId,
        title: (args.title ?? args.goal).slice(0, 120) || "Untitled background task",
        status: "queued",
        mode: "background",
        createdAt: now,
        updatedAt: now,
        attempt: 0,
      };
      tasks.set(task.taskId, task);
      return envelope({ task });
    },
    async pause(args: { taskId: string }): Promise<unknown> {
      return transition(args.taskId, "paused");
    },
    async resume(args: { taskId: string }): Promise<unknown> {
      return transition(args.taskId, "queued");
    },
    async cancel(args: { taskId: string }): Promise<unknown> {
      const current = tasks.get(args.taskId);
      if (!current) return failure(`not-found: ${args.taskId}`);
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        return failure(`invalid-transition: ${current.status} is terminal`);
      }
      if (current.status === "running") return transition(args.taskId, "cancelling");
      return transition(args.taskId, "cancelled");
    },
    async respond(args: { taskId: string; input: string }): Promise<unknown> {
      const current = tasks.get(args.taskId);
      if (!current) return failure(`not-found: ${args.taskId}`);
      if (current.status !== "waiting_input") {
        return failure(`invalid-transition: respond requires waiting_input`);
      }
      if (args.input.trim().length === 0) return failure("validation-error: input is empty");
      return transition(args.taskId, "running");
    },
  };
}
