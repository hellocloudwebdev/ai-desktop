// PR43: renderer — Background Task Center + Task Detail view
//
// Self-contained Task Center over App-owned background state. Owns no domain
// behavior: lifecycle, persistence, recovery, and permissions stay behind
// the sibling-owned `window.api.backgroundTasks` bridge (probed optionally
// via `getBackgroundTasksCommands`, so this surface renders an honest empty
// state both before and after the background IPC lands). Every bridge access
// is optional; all failures surface as text; async work here never throws.
//
// State survival: the renderer holds no source of truth. The list
// re-queries the bridge on mount, on project/scope change, and on a bounded
// poll interval, so remounts and disconnects recover by re-fetching.
// Transitions surface as `task.background.*` activity entries through the
// existing EventBus/activity projections — no separate notification bus.
//
// Security: titles ≤120, errors ≤2000, results ≤8000 chars;
// `key=value`-shaped secret material is redacted before render; no Node or
// Electron APIs, no spawned processes, no Prisma, no raw runtime internals.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BackgroundTaskStatus } from "@ai-desktop/ai-core";
import {
  BACKGROUND_ACTIVE_STATUSES,
  BACKGROUND_COMPLETED_STATUSES,
  MAX_BACKGROUND_ROWS_PER_SECTION,
  MAX_BACKGROUND_TIMELINE_ITEMS,
  backgroundStatusBadgeClass,
  backgroundStatusLabel,
  cancelBackgroundTask,
  countActiveBackgroundTasks,
  createLocalBackgroundTaskStub,
  fetchBackgroundTask,
  fetchBackgroundTaskList,
  filterBackgroundTasksByProject,
  formatBackgroundDuration,
  formatBackgroundTimestamp,
  getBackgroundTasksCommands,
  groupBackgroundTasks,
  pauseBackgroundTask,
  redactSecretAssignments,
  respondBackgroundTask,
  resumeBackgroundTask,
  truncateErrorText,
  truncateResultSummary,
  truncateText,
  truncateTitle,
  type BackgroundTaskView,
  type BackgroundTasksCommands,
} from "../../../workspace/background-tasks.js";
import type { ActivityEventView, BackgroundTaskCenterProps } from "./surface-props.js";

const DEFAULT_POLL_MS = 2000;

/** Statuses that accept a pause request. */
function canPause(status: BackgroundTaskStatus): boolean {
  return status === "running" || status === "waiting_permission" || status === "waiting_input";
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: BackgroundTaskView;
  selected: boolean;
  onSelect: (taskId: string | null) => void;
}): React.ReactElement {
  const resultRef = task.resultSummary
    ? truncateText(task.resultSummary.trim().split("\n")[0] ?? "", 120)
    : null;
  return (
    <li
      className={`rounded-lg p-2 text-xs border ${
        selected ? "bg-slate-800 border-indigo-600" : "bg-slate-800/60 border-transparent"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(selected ? null : task.taskId)}
        aria-pressed={selected}
        aria-label={`Background task ${truncateTitle(task.title)} (${backgroundStatusLabel(task.status)})`}
        className="w-full text-left focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded"
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="font-medium text-slate-200 truncate">{truncateTitle(task.title)}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${backgroundStatusBadgeClass(task.status)}`}
          >
            {backgroundStatusLabel(task.status)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-slate-400">
          <span title="Bound project (never re-scoped by project switching)">
            project:{task.projectId}
          </span>
          <span>{task.taskId.slice(0, 8)}…</span>
          <span>started {formatBackgroundTimestamp(task.startedAt ?? task.createdAt)}</span>
          <span>duration {formatBackgroundDuration(task)}</span>
          {typeof task.nodeCount === "number" && <span>{task.nodeCount} nodes</span>}
          {typeof task.attempt === "number" && task.attempt > 0 && (
            <span>attempt {task.attempt}</span>
          )}
        </div>
        {task.currentNode && (
          <p className="mt-1 text-[11px] text-slate-300 truncate">
            <span className="text-slate-500 font-mono">[{task.currentNode.status}]</span>{" "}
            {truncateText(task.currentNode.goal, 160)}
          </p>
        )}
        {task.lastError && (
          <p className="mt-1 text-[11px] text-rose-300 break-words">
            {truncateText(redactSecretAssignments(task.lastError), 240)}
          </p>
        )}
        {resultRef && (
          <p className="mt-1 text-[11px] text-emerald-200/80 truncate">result: {resultRef}</p>
        )}
      </button>
    </li>
  );
}

function StatusGroup({
  label,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  label: string;
  tasks: BackgroundTaskView[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
}): React.ReactElement | null {
  if (tasks.length === 0) return null;
  const visible = tasks.slice(0, MAX_BACKGROUND_ROWS_PER_SECTION);
  return (
    <section aria-label={label}>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 mt-3 px-1">
        {label} ({tasks.length})
      </p>
      <ul className="space-y-2">
        {visible.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            selected={selectedTaskId === task.taskId}
            onSelect={onSelectTask}
          />
        ))}
      </ul>
      {tasks.length > visible.length && (
        <p className="text-[10px] text-slate-500 px-1 mt-1">
          Showing {visible.length} of {tasks.length} — list bounded at render.
        </p>
      )}
    </section>
  );
}

function TaskDetail({
  task,
  taskActivity,
  pendingApprovalCount,
  onApprovePermission,
  onDenyPermission,
  approvalBusy,
  inputValue,
  onInputChange,
  onSubmitInput,
  inputBusy,
  actionError,
  actionBusy,
  onPause,
  onResume,
  onCancel,
  onClose,
  onRefresh,
}: {
  task: BackgroundTaskView;
  taskActivity: ActivityEventView[];
  pendingApprovalCount: number;
  onApprovePermission: (() => void) | null;
  onDenyPermission: (() => void) | null;
  approvalBusy: boolean;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmitInput: () => void;
  inputBusy: boolean;
  actionError: string | null;
  actionBusy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onClose: () => void;
  onRefresh: () => void;
}): React.ReactElement {
  const terminal =
    task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const timeline = taskActivity.slice(-MAX_BACKGROUND_TIMELINE_ITEMS);
  return (
    <section
      aria-label="Background task detail"
      className="mt-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="font-medium text-slate-100 truncate">{truncateTitle(task.title)}</p>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            Close
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-slate-500">Task</dt>
        <dd className="font-mono text-slate-300 break-all">{task.taskId}</dd>
        <dt className="text-slate-500">Project</dt>
        <dd className="font-mono text-slate-300 break-all">{task.projectId}</dd>
        <dt className="text-slate-500">Status</dt>
        <dd>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${backgroundStatusBadgeClass(task.status)}`}
          >
            {backgroundStatusLabel(task.status)}
          </span>
        </dd>
        <dt className="text-slate-500">Mode</dt>
        <dd className="font-mono text-slate-300">background</dd>
        <dt className="text-slate-500">Plan-graph summary</dt>
        <dd className="text-slate-300">
          {typeof task.nodeCount === "number" ? `${task.nodeCount} nodes` : "no node snapshot"}
          {task.attempt > 0 && ` · attempt ${task.attempt}`}
        </dd>
        <dt className="text-slate-500">Current step</dt>
        <dd className="text-slate-300 break-words">
          {task.currentNode
            ? `[${task.currentNode.status}] ${truncateText(task.currentNode.goal, 300)}`
            : "—"}
        </dd>
        <dt className="text-slate-500">Started</dt>
        <dd className="text-slate-300">{formatBackgroundTimestamp(task.startedAt)}</dd>
        <dt className="text-slate-500">Duration</dt>
        <dd className="text-slate-300">{formatBackgroundDuration(task)}</dd>
      </dl>

      {/* Permission approval: routed through the existing permission UI path
          (pending permissions + resolvePermission), never auto-approved here. */}
      {task.status === "waiting_permission" && (
        <div
          role="alert"
          className="mt-3.5 rounded-xl border border-amber-600/70 bg-amber-950/50 p-3.5 shadow-md"
        >
          <p className="font-semibold text-amber-200 text-xs">Background task requires approval</p>
          {onApprovePermission && onDenyPermission ? (
            <>
              <p className="text-amber-200/80 text-[11px] mt-1">
                {pendingApprovalCount > 0
                  ? `${pendingApprovalCount} pending permission request(s) available for review.`
                  : "No matching pending request is visible yet — refresh and review carefully."}
              </p>
              <div className="flex gap-2 mt-2.5">
                <button
                  type="button"
                  onClick={onApprovePermission}
                  disabled={approvalBusy}
                  className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50 shadow-sm"
                >
                  {approvalBusy ? "Resolving…" : "Approve (allow once)"}
                </button>
                <button
                  type="button"
                  onClick={onDenyPermission}
                  disabled={approvalBusy}
                  className="rounded-lg bg-rose-800 hover:bg-rose-700 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50 shadow-sm"
                >
                  {approvalBusy ? "Resolving…" : "Deny"}
                </button>
              </div>
              <p className="text-[10px] text-amber-300/60 mt-1.5">
                Resolves through the existing permission checkpoint — this surface never
                auto-approves.
              </p>
            </>
          ) : (
            <p className="text-orange-200/70 mt-1">
              Review and resolve it in the existing permission approval UI (Chat surface → pending
              permissions). This surface never auto-approves background work.
            </p>
          )}
        </div>
      )}

      {/* Input response: free-text data for the task (not a permission decision). */}
      {task.status === "waiting_input" && (
        <div className="mt-3.5 rounded-xl border border-amber-600/70 bg-amber-950/40 p-3.5 shadow-md">
          <label
            htmlFor="background-input-response"
            className="font-semibold text-amber-200 text-xs block mb-1.5"
          >
            Background task is waiting for input
          </label>
          <div className="flex items-center gap-2">
            <input
              id="background-input-response"
              type="text"
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmitInput();
              }}
              placeholder="Type the requested input…"
              disabled={inputBusy}
              aria-label="Input response for background task"
              className="flex-1 rounded-lg bg-slate-950/90 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 disabled:opacity-50 transition-all"
            />
            <button
              type="button"
              onClick={onSubmitInput}
              disabled={inputBusy || !inputValue.trim()}
              className="rounded-lg bg-amber-700 hover:bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors disabled:opacity-50"
            >
              {inputBusy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* Tool activity + timeline: existing EventBus/activity projections only. */}
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mt-3 mb-1">
        Tool activity & timeline ({timeline.length})
      </p>
      {timeline.length === 0 ? (
        <p className="text-slate-500 text-[11px]">
          No task activity yet. Transitions arrive as task.background.* events.
        </p>
      ) : (
        <ul aria-label="Background task timeline" className="space-y-1 max-h-40 overflow-y-auto">
          {timeline.map((e) => (
            <li key={e.key} className="flex items-baseline space-x-2 text-[11px]">
              <span className="text-slate-500 font-mono text-[10px] shrink-0">{e.time}</span>
              <span className="text-slate-300 break-words">{truncateText(e.label, 300)}</span>
            </li>
          ))}
        </ul>
      )}

      {task.resultSummary && (
        <>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mt-3 mb-1">
            Outputs
          </p>
          <p className="text-[11px] text-slate-300 whitespace-pre-wrap break-words">
            {truncateResultSummary(redactSecretAssignments(task.resultSummary))}
          </p>
        </>
      )}
      {task.lastError && (
        <>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mt-3 mb-1">
            Errors
          </p>
          <p className="text-[11px] text-rose-300 whitespace-pre-wrap break-words">
            {truncateErrorText(redactSecretAssignments(task.lastError))}
          </p>
        </>
      )}

      {actionError && (
        <p role="alert" className="text-rose-300 mt-2 text-[11px]">
          {truncateText(actionError, 500)}
        </p>
      )}
      {!terminal && (
        <div className="flex gap-2 mt-3">
          {canPause(task.status) && (
            <button
              type="button"
              onClick={onPause}
              disabled={actionBusy}
              className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
            >
              {actionBusy ? "Working…" : "Pause"}
            </button>
          )}
          {task.status === "paused" && (
            <button
              type="button"
              onClick={onResume}
              disabled={actionBusy}
              title="Resume re-queues the task; the scheduler restarts it."
              className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
            >
              {actionBusy ? "Working…" : "Resume (re-queue)"}
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={actionBusy}
            className="rounded px-2 py-1 text-[11px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200 disabled:opacity-50"
          >
            {actionBusy ? "Working…" : "Cancel"}
          </button>
        </div>
      )}
    </section>
  );
}

export function BackgroundTaskCenter({
  activeProjectId,
  selectedTaskId = null,
  onSelectTask = () => {},
  scopeAllProjects = false,
  onToggleScope,
  taskActivity = [],
  pendingPermissions = [],
  onResolvePermission,
  pollIntervalMs = DEFAULT_POLL_MS,
  commands: injectedCommands,
}: BackgroundTaskCenterProps): React.ReactElement {
  // Bridge probe with local-stub fallback: the stub keeps the surface
  // operable (honest empty state) before the sibling IPC lands, and tests
  // pass without Electron. Real state always re-queries on mount.
  const [stub] = useState<BackgroundTasksCommands>(() => createLocalBackgroundTaskStub());
  const commands = injectedCommands ?? getBackgroundTasksCommands() ?? stub;
  const bridgeAbsent = injectedCommands == null && getBackgroundTasksCommands() === null;

  const [tasks, setTasks] = useState<BackgroundTaskView[]>([]);
  const [detail, setDetail] = useState<BackgroundTaskView | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [approvalBusy, setApprovalBusy] = useState<boolean>(false);
  const [inputValue, setInputValue] = useState<string>("");
  const [inputBusy, setInputBusy] = useState<boolean>(false);

  const refreshList = useCallback(async () => {
    try {
      const views = await fetchBackgroundTaskList(
        commands,
        scopeAllProjects ? undefined : activeProjectId,
      );
      // Belt-and-braces isolation: the bridge should already scope, but the
      // renderer never displays a task outside the selected scope.
      const scoped =
        scopeAllProjects || !activeProjectId
          ? views
          : filterBackgroundTasksByProject(views, activeProjectId);
      setTasks(scoped);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [commands, scopeAllProjects, activeProjectId]);

  // Re-query on mount / scope change + bounded poll. No renderer-local
  // source of truth: remounts and disconnects recover by re-fetching.
  useEffect(() => {
    setLoading(true);
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void refreshList();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [refreshList, pollIntervalMs]);

  const refreshDetail = useCallback(async () => {
    if (!selectedTaskId) {
      setDetail(null);
      return;
    }
    try {
      const view = await fetchBackgroundTask(commands, selectedTaskId);
      // A task that no longer exists (or moved out of scope) clears the
      // detail instead of rendering stale state.
      setDetail(view);
    } catch {
      setDetail(null);
    }
  }, [commands, selectedTaskId]);

  useEffect(() => {
    void refreshDetail();
  }, [refreshDetail]);

  // Selecting a task clears the response box; the detail re-queries above.
  useEffect(() => {
    setInputValue("");
    setActionError(null);
  }, [selectedTaskId]);

  const handlePause = useCallback(async () => {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError(null);
    const result = await pauseBackgroundTask(commands, selectedTaskId);
    if (!result.ok) setActionError(result.error);
    await refreshList();
    await refreshDetail();
    setActionBusy(false);
  }, [commands, selectedTaskId, refreshList, refreshDetail]);

  const handleResume = useCallback(async () => {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError(null);
    const result = await resumeBackgroundTask(commands, selectedTaskId);
    if (!result.ok) setActionError(result.error);
    await refreshList();
    await refreshDetail();
    setActionBusy(false);
  }, [commands, selectedTaskId, refreshList, refreshDetail]);

  const handleCancel = useCallback(async () => {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError(null);
    const result = await cancelBackgroundTask(commands, selectedTaskId);
    if (!result.ok) setActionError(result.error);
    await refreshList();
    await refreshDetail();
    setActionBusy(false);
  }, [commands, selectedTaskId, refreshList, refreshDetail]);

  const handleSubmitInput = useCallback(async () => {
    if (!selectedTaskId || !inputValue.trim()) return;
    setInputBusy(true);
    setActionError(null);
    const result = await respondBackgroundTask(commands, selectedTaskId, inputValue.trim());
    if (!result.ok) {
      setActionError(result.error);
    } else {
      setInputValue("");
    }
    await refreshList();
    await refreshDetail();
    setInputBusy(false);
  }, [commands, selectedTaskId, inputValue, refreshList, refreshDetail]);

  // Permission approval always flows through the existing permission UI
  // path (pending permissions + resolvePermission). The first pending
  // request is offered for review; nothing here auto-approves.
  const handleApprovePermission = useCallback(async () => {
    const first = pendingPermissions[0];
    if (!first || !onResolvePermission) return;
    setApprovalBusy(true);
    try {
      await onResolvePermission(first.id, "granted", "allow_once");
    } finally {
      setApprovalBusy(false);
    }
    await refreshList();
    await refreshDetail();
  }, [pendingPermissions, onResolvePermission, refreshList, refreshDetail]);

  const handleDenyPermission = useCallback(async () => {
    const first = pendingPermissions[0];
    if (!first || !onResolvePermission) return;
    setApprovalBusy(true);
    try {
      await onResolvePermission(first.id, "denied", "deny");
    } finally {
      setApprovalBusy(false);
    }
    await refreshList();
    await refreshDetail();
  }, [pendingPermissions, onResolvePermission, refreshList, refreshDetail]);

  const grouped = useMemo(() => groupBackgroundTasks(tasks), [tasks]);
  const activeCount = useMemo(() => countActiveBackgroundTasks(tasks), [tasks]);

  // Timeline: existing activity projections filtered to task transitions.
  // Activity entries carry no task id, so the detail shows the bounded
  // task-kind slice; App may narrow further via the taskActivity prop.
  const taskTimeline = useMemo(() => taskActivity.filter((e) => e.kind === "task"), [taskActivity]);

  const activeByStatus = useMemo(() => {
    const buckets = new Map<BackgroundTaskStatus, BackgroundTaskView[]>();
    for (const status of BACKGROUND_ACTIVE_STATUSES) buckets.set(status, []);
    for (const task of grouped.active) buckets.get(task.status)?.push(task);
    return buckets;
  }, [grouped]);

  const completedByStatus = useMemo(() => {
    const buckets = new Map<BackgroundTaskStatus, BackgroundTaskView[]>();
    for (const status of BACKGROUND_COMPLETED_STATUSES) buckets.set(status, []);
    for (const task of grouped.completed) buckets.get(task.status)?.push(task);
    return buckets;
  }, [grouped]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pt-4">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Background tasks{activeCount > 0 ? ` (${activeCount} active)` : ""}
        </p>
        <div className="flex items-center gap-2">
          {onToggleScope && (
            <button
              type="button"
              onClick={() => onToggleScope(!scopeAllProjects)}
              aria-pressed={scopeAllProjects}
              title="Project switching never re-scopes a task: rows always show the bound project."
              className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              {scopeAllProjects ? "All projects" : "This project"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshList()}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            Refresh
          </button>
        </div>
      </div>
      {bridgeAbsent && (
        <p className="text-[11px] text-slate-500 px-6 pt-2">
          Background IPC is not available yet — showing local state. The center re-queries
          automatically once the background bridge lands.
        </p>
      )}
      {loading ? (
        <p className="text-xs text-slate-500 px-6 py-4">Loading background tasks…</p>
      ) : (
        <div className="px-6 pb-2">
          {refreshError && (
            <p role="alert" className="text-rose-300 text-xs mt-2">
              {truncateText(refreshError, 500)}
            </p>
          )}
          {tasks.length === 0 && !refreshError ? (
            <p className="text-xs text-slate-500 py-4">
              No background tasks{scopeAllProjects ? "" : " in this project"} yet.
            </p>
          ) : (
            <>
              <section aria-label="Active background tasks">
                {grouped.active.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">No active background tasks.</p>
                ) : (
                  <>
                    {BACKGROUND_ACTIVE_STATUSES.map((status) => (
                      <StatusGroup
                        key={status}
                        label={backgroundStatusLabel(status)}
                        tasks={activeByStatus.get(status) ?? []}
                        selectedTaskId={selectedTaskId}
                        onSelectTask={onSelectTask}
                      />
                    ))}
                  </>
                )}
              </section>
              <section aria-label="Completed background tasks" className="mt-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-1">
                  Completed ({grouped.completed.length})
                </p>
                {grouped.completed.length === 0 ? (
                  <p className="text-xs text-slate-500 py-1">Nothing completed yet.</p>
                ) : (
                  <>
                    {BACKGROUND_COMPLETED_STATUSES.map((status) => (
                      <StatusGroup
                        key={status}
                        label={backgroundStatusLabel(status)}
                        tasks={completedByStatus.get(status) ?? []}
                        selectedTaskId={selectedTaskId}
                        onSelectTask={onSelectTask}
                      />
                    ))}
                  </>
                )}
              </section>
            </>
          )}
          {detail && (
            <TaskDetail
              task={detail}
              taskActivity={taskTimeline}
              pendingApprovalCount={pendingPermissions.length}
              onApprovePermission={onResolvePermission ? handleApprovePermission : null}
              onDenyPermission={onResolvePermission ? handleDenyPermission : null}
              approvalBusy={approvalBusy}
              inputValue={inputValue}
              onInputChange={setInputValue}
              onSubmitInput={() => void handleSubmitInput()}
              inputBusy={inputBusy}
              actionError={actionError}
              actionBusy={actionBusy}
              onPause={() => void handlePause()}
              onResume={() => void handleResume()}
              onCancel={() => void handleCancel()}
              onClose={() => onSelectTask(null)}
              onRefresh={() => void refreshDetail()}
            />
          )}
        </div>
      )}
    </div>
  );
}
