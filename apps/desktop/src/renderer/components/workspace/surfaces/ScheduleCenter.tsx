// PR44: renderer — Schedule Center + Schedule Detail view
//
// Self-contained Schedule Center over App-owned schedule state. Owns no
// domain behavior: lifecycle, persistence, recovery, timezones, and
// permissions stay behind the sibling-owned `window.api.schedules` bridge
// (probed optionally via `getScheduleCommands`, so this surface renders an
// honest empty state both before and after the schedules IPC lands). Every
// bridge access is optional; all failures surface as text; async work here
// never throws.
//
// State survival: the renderer holds no source of truth. The list
// re-queries the bridge on mount, on project/scope change, and on a single
// bounded poll interval, so remounts and disconnects recover by
// re-fetching. Run history re-queries with the detail; transitions surface
// as `task.background.*`/schedule activity entries through the existing
// EventBus/activity projections — no separate notification bus.
//
// Security: names ≤120, prompts ≤4000 chars; `key=value`-shaped secret
// material is redacted before render; no Node or Electron APIs, no spawned
// processes, no Prisma, no raw runtime internals. Nothing executes from a
// partial form: create/update fire only after `validateScheduleForm`
// reports zero errors.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MAX_SCHEDULE_ROWS_PER_SECTION,
  MAX_SCHEDULE_RUNS_SHOWN,
  countEnabledSchedules,
  createLocalScheduleStub,
  createSchedule,
  deleteSchedule,
  describeSchedule,
  disableSchedule,
  enableSchedule,
  fetchSchedule,
  fetchScheduleList,
  fetchScheduleRuns,
  filterSchedulesByProject,
  formatNextRunCountdown,
  formatScheduleRunDuration,
  formatScheduleTimestamp,
  getScheduleCommands,
  groupSchedules,
  isScheduleFormValid,
  redactSecretAssignments,
  runScheduleNow,
  scheduleRunStatusBadgeClass,
  scheduleRunStatusLabel,
  scheduleTriggerLabel,
  toDisplayOverlapPolicy,
  truncateScheduleName,
  truncateSchedulePrompt,
  truncateText,
  updateSchedule,
  validateScheduleForm,
  type ScheduleCommands,
  type ScheduleFormInput,
  type ScheduleRunView,
  type ScheduleView,
} from "../../../workspace/schedules.js";
import type { ScheduleCenterProps } from "./surface-props.js";

const DEFAULT_POLL_MS = 2000;

const EMPTY_FORM: ScheduleFormInput = {
  name: "",
  projectId: "",
  prompt: "",
  kind: "interval",
  intervalMs: 3_600_000,
  delayMs: 3_600_000,
  runAt: "",
  dailyTime: "09:00",
  weekday: 1,
  hour: 9,
  minute: 0,
  timezone: "UTC",
  overlap: "skip",
  missedPolicy: "skip",
  enabled: true,
};

function ScheduleRow({
  schedule,
  selected,
  onSelect,
}: {
  schedule: ScheduleView;
  selected: boolean;
  onSelect: (scheduleId: string | null) => void;
}): React.ReactElement {
  const status = schedule.enabled ? "Enabled" : "Disabled";
  const lastStatus = schedule.lastRunStatus ? ` · last ${schedule.lastRunStatus}` : "";
  return (
    <li
      className={`rounded-lg p-2 text-xs border ${
        selected ? "bg-slate-800 border-indigo-600" : "bg-slate-800/60 border-transparent"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(selected ? null : schedule.scheduleId)}
        aria-pressed={selected}
        aria-label={`Schedule ${truncateScheduleName(schedule.name)} (${status})`}
        className="w-full text-left focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded"
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="font-medium text-slate-200 truncate">
            {truncateScheduleName(schedule.name)}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              schedule.enabled ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-400"
            }`}
          >
            {status}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-slate-400">
          <span title="Bound project (never re-scoped by project switching)">
            project:{schedule.projectId}
          </span>
          <span>{schedule.scheduleId.slice(0, 8)}…</span>
          <span>Next run {formatScheduleTimestamp(schedule.nextRunAt)}</span>
          <span>Last run {formatScheduleTimestamp(schedule.lastRunAt)}</span>
          <span>Status {status + lastStatus}</span>
        </div>
        <p className="mt-1 text-[11px] text-slate-400 truncate">
          {schedule.scheduleDescription ?? describeSchedule(schedule)} · {schedule.timezone}
        </p>
      </button>
    </li>
  );
}

function ScheduleGroup({
  label,
  schedules,
  selectedScheduleId,
  onSelectSchedule,
}: {
  label: string;
  schedules: ScheduleView[];
  selectedScheduleId: string | null;
  onSelectSchedule: (scheduleId: string | null) => void;
}): React.ReactElement | null {
  if (schedules.length === 0) return null;
  const visible = schedules.slice(0, MAX_SCHEDULE_ROWS_PER_SECTION);
  return (
    <section aria-label={label}>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 mt-3 px-1">
        {label} ({schedules.length})
      </p>
      <ul className="space-y-2">
        {visible.map((schedule) => (
          <ScheduleRow
            key={schedule.scheduleId}
            schedule={schedule}
            selected={selectedScheduleId === schedule.scheduleId}
            onSelect={onSelectSchedule}
          />
        ))}
      </ul>
      {schedules.length > visible.length && (
        <p className="text-[10px] text-slate-500 px-1 mt-1">
          Showing {visible.length} of {schedules.length} — list bounded at render.
        </p>
      )}
    </section>
  );
}

function RunHistory({
  runs,
  pendingApprovalCount,
  onApprovePermission,
  onDenyPermission,
  approvalBusy,
}: {
  runs: ScheduleRunView[];
  pendingApprovalCount: number;
  onApprovePermission: (() => void) | null;
  onDenyPermission: (() => void) | null;
  approvalBusy: boolean;
}): React.ReactElement {
  const visible = runs.slice(0, MAX_SCHEDULE_RUNS_SHOWN);
  // Downstream approval: a launched run parks on the existing permission
  // checkpoint (a background-task concern, not a schedule-run status), so
  // the banner keys off the shared pending-permission queue plus an active
  // run — never off a run status, and never auto-approving.
  const hasActiveRun = runs.some((r) => r.status === "pending" || r.status === "running");
  const showApprovalBanner = pendingApprovalCount > 0 && hasActiveRun;
  return (
    <div className="mt-3">
      {/* Downstream approval: runs launched from schedules park on the
          existing permission checkpoint — this surface never auto-approves. */}
      {showApprovalBanner && (
        <div role="alert" className="rounded-lg border border-orange-700 bg-orange-950/40 p-2 mb-2">
          <p className="font-medium text-orange-200">Schedule run requires approval</p>
          {onApprovePermission && onDenyPermission ? (
            <>
              <p className="text-orange-200/70 mt-1 text-[11px]">
                {pendingApprovalCount > 0
                  ? `${pendingApprovalCount} pending permission request(s) available for review.`
                  : "No matching pending request is visible yet — refresh and review carefully."}
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={onApprovePermission}
                  disabled={approvalBusy}
                  className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                >
                  {approvalBusy ? "Resolving…" : "Approve (allow once)"}
                </button>
                <button
                  type="button"
                  onClick={onDenyPermission}
                  disabled={approvalBusy}
                  className="rounded-lg bg-rose-800 hover:bg-rose-700 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                >
                  {approvalBusy ? "Resolving…" : "Deny"}
                </button>
              </div>
              <p className="text-[10px] text-orange-200/50 mt-1">
                Resolves through the existing permission checkpoint — this surface never
                auto-approves. A schedule is never a grant.
              </p>
            </>
          ) : (
            <p className="text-orange-200/70 mt-1 text-[11px]">
              Review and resolve it in the existing permission approval UI (Chat surface → pending
              permissions). This surface never auto-approves.
            </p>
          )}
        </div>
      )}
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
        Run history ({runs.length})
      </p>
      {runs.length === 0 ? (
        <p className="text-slate-500 text-[11px]">No runs recorded for this schedule yet.</p>
      ) : (
        <>
          <ul aria-label="Schedule run history" className="space-y-1 max-h-40 overflow-y-auto">
            {visible.map((run) => (
              <li
                key={run.runId}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] rounded bg-slate-800/60 px-2 py-1"
              >
                <span className="font-mono text-slate-400">{run.runId.slice(0, 8)}…</span>
                <span className="font-mono text-slate-400" title="Bound project">
                  project:{run.projectId}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${scheduleRunStatusBadgeClass(run.status)}`}
                >
                  {scheduleRunStatusLabel(run.status)}
                </span>
                <span className="text-slate-300">trigger:{scheduleTriggerLabel(run.trigger)}</span>
                <span className="text-slate-400">
                  started {formatScheduleTimestamp(run.startedAt ?? run.createdAt)}
                </span>
                <span className="text-slate-400">
                  finished {formatScheduleTimestamp(run.finishedAt)}
                </span>
                <span className="text-slate-500">duration {formatScheduleRunDuration(run)}</span>
                {run.taskId && (
                  <span className="font-mono text-slate-500">task:{run.taskId.slice(0, 8)}…</span>
                )}
                {run.errorSnippet && (
                  <span className="text-rose-300 break-words w-full">
                    {truncateText(redactSecretAssignments(run.errorSnippet), 240)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {runs.length > visible.length && (
            <p className="text-[10px] text-slate-500 mt-1">
              Showing {visible.length} of {runs.length} — run history bounded at render.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ScheduleForm({
  initial,
  projectLocked,
  busy,
  formError,
  onSubmit,
  onCancel,
}: {
  initial: ScheduleFormInput;
  projectLocked: boolean;
  busy: boolean;
  formError: string | null;
  onSubmit: (input: ScheduleFormInput) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [form, setForm] = useState<ScheduleFormInput>(initial);
  useEffect(() => {
    setForm(initial);
  }, [initial]);
  const errors = validateScheduleForm(form);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof ScheduleFormInput>(key: K, value: ScheduleFormInput[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Nothing executes from a partial form: the submit button stays disabled
  // until `validateScheduleForm` reports zero errors, and `onSubmit` fires
  // only from the valid submit path below.
  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isScheduleFormValid(form) || busy) return;
    onSubmit(form);
  };

  return (
    <form
      aria-label={projectLocked ? "Edit schedule" : "Create schedule"}
      onSubmit={handleSubmit}
      className="mt-3.5 rounded-xl border border-slate-800/90 bg-slate-900/70 p-4.5 text-xs space-y-3 shadow-md shadow-black/20"
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="text-slate-400 text-[11px] font-medium">Name (≤120)</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            aria-label="Schedule name"
            disabled={busy}
            className="mt-1 w-full rounded-lg bg-slate-950/90 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 transition-all"
          />
          {errors.name && (
            <span className="text-rose-300 text-[11px] mt-1 block">{errors.name}</span>
          )}
        </label>
        <label className="block col-span-2">
          <span className="text-slate-400 text-[11px] font-medium">
            Project{projectLocked ? " (locked per schedule)" : ""}
          </span>
          <input
            type="text"
            value={form.projectId}
            onChange={(e) => set("projectId", e.target.value)}
            aria-label="Schedule project"
            disabled={busy || projectLocked}
            title={
              projectLocked
                ? "Project choice locked per schedule: editing never re-scopes a schedule."
                : "Project that owns this schedule"
            }
            className="mt-1 w-full rounded-lg bg-slate-950/90 border border-slate-700/80 px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 transition-all"
          />
          {errors.projectId && (
            <span className="text-rose-300 text-[11px] mt-1 block">{errors.projectId}</span>
          )}
        </label>
        <label className="block col-span-2">
          <span className="text-slate-400 text-[11px] font-medium">Prompt (≤4000)</span>
          <textarea
            value={form.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            aria-label="Schedule prompt"
            disabled={busy}
            rows={3}
            className="mt-1 w-full rounded-lg bg-slate-950/90 border border-slate-700/80 px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 transition-all leading-relaxed"
          />
          {errors.prompt && (
            <span className="text-rose-300 text-[11px] mt-1 block">{errors.prompt}</span>
          )}
        </label>
        <label className="block">
          <span className="text-slate-400 text-[11px] font-medium">Schedule kind</span>
          <select
            value={form.kind}
            onChange={(e) => set("kind", e.target.value)}
            aria-label="Schedule kind"
            disabled={busy}
            className="mt-1 w-full rounded-lg bg-slate-950/90 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50 transition-all cursor-pointer"
          >
            <option value="interval">Interval</option>
            <option value="delay">Delay once</option>
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          {errors.kind && (
            <span className="text-rose-300 text-[11px] mt-1 block">{errors.kind}</span>
          )}
        </label>
        <label className="block">
          <span className="text-slate-400 text-[11px] font-medium">Timezone (IANA)</span>
          <input
            type="text"
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            aria-label="Schedule timezone"
            disabled={busy}
            placeholder="UTC"
            className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />
          {errors.timezone && <span className="text-rose-300 text-[11px]">{errors.timezone}</span>}
        </label>
        {form.kind === "interval" && (
          <label className="block col-span-2">
            <span className="text-slate-400 text-[11px]">Interval (minutes, ≥1)</span>
            <input
              type="number"
              min={1}
              value={Math.round((form.intervalMs ?? 3_600_000) / 60_000)}
              onChange={(e) => set("intervalMs", Math.round(Number(e.target.value) * 60_000) || 0)}
              aria-label="Schedule interval minutes"
              disabled={busy}
              className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            {errors.intervalMs && (
              <span className="text-rose-300 text-[11px]">{errors.intervalMs}</span>
            )}
          </label>
        )}
        {form.kind === "once" && (
          <label className="block col-span-2">
            <span className="text-slate-400 text-[11px]">Run at (date/time)</span>
            <input
              type="datetime-local"
              value={form.runAt ?? ""}
              onChange={(e) => set("runAt", e.target.value)}
              aria-label="Schedule run-at time"
              disabled={busy}
              className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            {errors.runAt && <span className="text-rose-300 text-[11px]">{errors.runAt}</span>}
          </label>
        )}
        {form.kind === "daily" && (
          <label className="block col-span-2">
            <span className="text-slate-400 text-[11px]">Daily time (HH:MM)</span>
            <input
              type="time"
              value={form.dailyTime ?? "09:00"}
              onChange={(e) => set("dailyTime", e.target.value)}
              aria-label="Schedule daily time"
              disabled={busy}
              className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            {errors.dailyTime && (
              <span className="text-rose-300 text-[11px]">{errors.dailyTime}</span>
            )}
          </label>
        )}
        {form.kind === "delay" && (
          <label className="block col-span-2">
            <span className="text-slate-400 text-[11px]">Delay (minutes, ≥1)</span>
            <input
              type="number"
              min={1}
              value={Math.round((form.delayMs ?? 3_600_000) / 60_000)}
              onChange={(e) => set("delayMs", Math.round(Number(e.target.value) * 60_000) || 0)}
              aria-label="Schedule delay minutes"
              disabled={busy}
              className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            {errors.delayMs && <span className="text-rose-300 text-[11px]">{errors.delayMs}</span>}
          </label>
        )}
        {form.kind === "weekly" && (
          <fieldset className="col-span-2 grid grid-cols-3 gap-2">
            <legend className="text-slate-400 text-[11px]">Weekly schedule</legend>
            <label className="block">
              <span className="text-slate-400 text-[11px]">Weekday</span>
              <select
                value={form.weekday ?? 1}
                onChange={(e) => set("weekday", Number(e.target.value))}
                aria-label="Schedule weekday"
                disabled={busy}
                className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              >
                <option value={0}>Sunday</option>
                <option value={1}>Monday</option>
                <option value={2}>Tuesday</option>
                <option value={3}>Wednesday</option>
                <option value={4}>Thursday</option>
                <option value={5}>Friday</option>
                <option value={6}>Saturday</option>
              </select>
              {errors.weekday && (
                <span className="text-rose-300 text-[11px]">{errors.weekday}</span>
              )}
            </label>
            <label className="block">
              <span className="text-slate-400 text-[11px]">Hour</span>
              <input
                type="number"
                min={0}
                max={23}
                value={form.hour ?? 9}
                onChange={(e) => set("hour", Number(e.target.value))}
                aria-label="Schedule hour"
                disabled={busy}
                className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              {errors.hour && <span className="text-rose-300 text-[11px]">{errors.hour}</span>}
            </label>
            <label className="block">
              <span className="text-slate-400 text-[11px]">Minute</span>
              <input
                type="number"
                min={0}
                max={59}
                value={form.minute ?? 0}
                onChange={(e) => set("minute", Number(e.target.value))}
                aria-label="Schedule minute"
                disabled={busy}
                className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              {errors.minute && <span className="text-rose-300 text-[11px]">{errors.minute}</span>}
            </label>
          </fieldset>
        )}
        <label className="block">
          <span className="text-slate-400 text-[11px]">Overlap policy</span>
          <select
            value={form.overlap}
            onChange={(e) => set("overlap", e.target.value)}
            aria-label="Schedule overlap policy"
            disabled={busy}
            className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          >
            <option value="skip">Skip overlapping tick (default)</option>
            <option value="queue">Queue overlapping tick</option>
          </select>
          {errors.overlap && <span className="text-rose-300 text-[11px]">{errors.overlap}</span>}
        </label>
        <label className="block">
          <span className="text-slate-400 text-[11px]">Missed-run policy</span>
          <select
            value={form.missedPolicy}
            onChange={(e) => set("missedPolicy", e.target.value)}
            aria-label="Schedule missed-run policy"
            disabled={busy}
            className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          >
            <option value="skip">Skip missed ticks (default)</option>
            <option value="run_once">Catch up once</option>
          </select>
          {errors.missedPolicy && (
            <span className="text-rose-300 text-[11px]">{errors.missedPolicy}</span>
          )}
        </label>
        <label className="flex items-center gap-2 col-span-2 text-[11px] text-slate-300">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            disabled={busy}
            aria-label="Schedule enabled"
          />
          Enabled
        </label>
      </div>
      {formError && (
        <p role="alert" className="text-rose-300 text-[11px]">
          {truncateText(formError, 500)}
        </p>
      )}
      {!valid && (
        <p className="text-[11px] text-slate-500">
          Complete the highlighted fields — nothing executes from a partial form.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !valid}
          title={valid ? "Submit the validated schedule" : "Fix validation errors to submit"}
          className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : projectLocked ? "Save changes" : "Create schedule"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScheduleDetail({
  schedule,
  runs,
  pendingApprovalCount,
  onApprovePermission,
  onDenyPermission,
  approvalBusy,
  actionError,
  actionBusy,
  onRunNow,
  onToggleEnabled,
  onDelete,
  onEdit,
  onClose,
  onRefresh,
}: {
  schedule: ScheduleView;
  runs: ScheduleRunView[];
  pendingApprovalCount: number;
  onApprovePermission: (() => void) | null;
  onDenyPermission: (() => void) | null;
  approvalBusy: boolean;
  actionError: string | null;
  actionBusy: boolean;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onClose: () => void;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <section
      aria-label="Schedule detail"
      className="mt-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="font-medium text-slate-100 truncate">{truncateScheduleName(schedule.name)}</p>
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
        <dt className="text-slate-500">Schedule</dt>
        <dd className="font-mono text-slate-300 break-all">{schedule.scheduleId}</dd>
        <dt className="text-slate-500">Project</dt>
        <dd className="font-mono text-slate-300 break-all">{schedule.projectId}</dd>
        <dt className="text-slate-500">Prompt</dt>
        <dd className="text-slate-300 whitespace-pre-wrap break-words">
          {truncateSchedulePrompt(redactSecretAssignments(schedule.prompt)) || "—"}
        </dd>
        <dt className="text-slate-500">Schedule</dt>
        <dd className="text-slate-300">
          {schedule.scheduleDescription ?? describeSchedule(schedule)}
        </dd>
        <dt className="text-slate-500">Timezone</dt>
        <dd className="font-mono text-slate-300">{schedule.timezone}</dd>
        <dt className="text-slate-500">Next run</dt>
        <dd className="text-slate-300">
          {formatScheduleTimestamp(schedule.nextRunAt)} (
          {formatNextRunCountdown(schedule.nextRunAt)})
        </dd>
        <dt className="text-slate-500">Previous run</dt>
        <dd className="text-slate-300">
          {formatScheduleTimestamp(schedule.lastRunAt)}
          {schedule.lastRunStatus ? ` · ${schedule.lastRunStatus}` : ""}
        </dd>
        <dt className="text-slate-500">Overlap policy</dt>
        <dd className="text-slate-300">{toDisplayOverlapPolicy(schedule.overlap)}</dd>
        <dt className="text-slate-500">Missed-run policy</dt>
        <dd className="text-slate-300">{schedule.missedPolicy}</dd>
        <dt className="text-slate-500">Enabled</dt>
        <dd>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              schedule.enabled ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-400"
            }`}
          >
            {schedule.enabled ? "Enabled" : "Disabled"}
          </span>
        </dd>
      </dl>

      <RunHistory
        runs={runs}
        pendingApprovalCount={pendingApprovalCount}
        onApprovePermission={onApprovePermission}
        onDenyPermission={onDenyPermission}
        approvalBusy={approvalBusy}
      />

      {actionError && (
        <p role="alert" className="text-rose-300 mt-2 text-[11px]">
          {truncateText(actionError, 500)}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={onRunNow}
          disabled={actionBusy}
          title="Launch one manual run now (labeled Manual in history)"
          className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
        >
          {actionBusy ? "Working…" : "Run now"}
        </button>
        <button
          type="button"
          onClick={onToggleEnabled}
          disabled={actionBusy}
          className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
        >
          {actionBusy ? "Working…" : schedule.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={actionBusy}
          className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={actionBusy}
          title="Deleting a schedule does not cancel any running task"
          className="rounded px-2 py-1 text-[11px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200 disabled:opacity-50"
        >
          {actionBusy ? "Working…" : "Delete"}
        </button>
      </div>
      <p className="text-[10px] text-slate-500 mt-2">
        Deleting a schedule does not cancel any running task — runs already launched keep their own
        lifecycle.
      </p>
    </section>
  );
}

export function ScheduleCenter({
  activeProjectId,
  selectedScheduleId = null,
  onSelectSchedule = () => {},
  scopeAllProjects = false,
  onToggleScope,
  taskActivity = [],
  pendingPermissions = [],
  onResolvePermission,
  pollIntervalMs = DEFAULT_POLL_MS,
  commands: injectedCommands,
}: ScheduleCenterProps): React.ReactElement {
  // Bridge probe with local-stub fallback: the stub keeps the surface
  // operable (honest empty state) before the sibling IPC lands, and tests
  // pass without Electron. Real state always re-queries on mount.
  const [stub] = useState<ScheduleCommands>(() => createLocalScheduleStub());
  const commands = injectedCommands ?? getScheduleCommands() ?? stub;
  const bridgeAbsent = injectedCommands == null && getScheduleCommands() === null;

  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [detail, setDetail] = useState<ScheduleView | null>(null);
  const [runs, setRuns] = useState<ScheduleRunView[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [approvalBusy, setApprovalBusy] = useState<boolean>(false);
  const [formMode, setFormMode] = useState<"closed" | "create" | "edit">("closed");
  const [formBusy, setFormBusy] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      // The schedules list is project-scoped main-side: without an active
      // project there is nothing queryable (no unscoped listing exists).
      if (!activeProjectId) {
        setSchedules([]);
        setRefreshError(null);
        return;
      }
      const views = await fetchScheduleList(commands, activeProjectId);
      // Belt-and-braces isolation: the bridge already scopes, but the
      // renderer never displays a schedule outside the selected scope.
      const scoped =
        scopeAllProjects || !activeProjectId
          ? views
          : filterSchedulesByProject(views, activeProjectId);
      setSchedules(scoped);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [commands, scopeAllProjects, activeProjectId]);

  const refreshDetailAndRuns = useCallback(async () => {
    if (!selectedScheduleId) {
      setDetail(null);
      setRuns([]);
      return;
    }
    // Ownership is verified main-side: a project mismatch clears the detail
    // instead of rendering stale or foreign state.
    const projectId = detail?.projectId ?? activeProjectId ?? "";
    if (!projectId) {
      setDetail(null);
      setRuns([]);
      return;
    }
    try {
      const view = await fetchSchedule(commands, selectedScheduleId, projectId);
      // A schedule that no longer exists (or moved out of scope) clears the
      // detail instead of rendering stale state.
      setDetail(view);
      if (view) {
        setRuns(await fetchScheduleRuns(commands, selectedScheduleId, view.projectId));
      } else {
        setRuns([]);
      }
    } catch {
      setDetail(null);
      setRuns([]);
    }
  }, [commands, selectedScheduleId, detail?.projectId, activeProjectId]);

  const refreshAll = useCallback(async () => {
    await refreshList();
    await refreshDetailAndRuns();
  }, [refreshList, refreshDetailAndRuns]);

  // Re-query on mount / scope change + a single bounded poll. No
  // renderer-local source of truth: remounts and disconnects recover by
  // re-fetching.
  useEffect(() => {
    setLoading(true);
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void refreshAll();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [refreshAll, pollIntervalMs]);

  // Selecting a schedule closes the form box; the detail re-queries above.
  useEffect(() => {
    setFormMode("closed");
    setFormError(null);
    setActionError(null);
  }, [selectedScheduleId]);

  const handleRunNow = useCallback(async () => {
    if (!selectedScheduleId) return;
    const projectId = detail?.projectId ?? activeProjectId ?? "";
    if (!projectId) return;
    setActionBusy(true);
    setActionError(null);
    const result = await runScheduleNow(commands, selectedScheduleId, projectId);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [commands, selectedScheduleId, detail?.projectId, activeProjectId, refreshAll]);

  const handleToggleEnabled = useCallback(async () => {
    if (!selectedScheduleId || !detail) return;
    setActionBusy(true);
    setActionError(null);
    const result = detail.enabled
      ? await disableSchedule(commands, selectedScheduleId, detail.projectId)
      : await enableSchedule(commands, selectedScheduleId, detail.projectId);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [commands, selectedScheduleId, detail, refreshAll]);

  const handleDelete = useCallback(async () => {
    if (!selectedScheduleId || !detail) return;
    setActionBusy(true);
    setActionError(null);
    const result = await deleteSchedule(commands, selectedScheduleId, detail.projectId);
    if (!result.ok) {
      setActionError(result.error);
    } else {
      onSelectSchedule(null);
    }
    await refreshList();
    setActionBusy(false);
  }, [commands, selectedScheduleId, detail, refreshList, onSelectSchedule]);

  const handleSubmitForm = useCallback(
    async (input: ScheduleFormInput) => {
      // Nothing executes from a partial form: reject invalid input before
      // any bridge call.
      if (!isScheduleFormValid(input)) {
        setFormError("Fix validation errors before submitting.");
        return;
      }
      setFormBusy(true);
      setFormError(null);
      try {
        if (formMode === "create") {
          const result = await createSchedule(commands, input);
          if (!result.ok) {
            setFormError(result.error);
          } else {
            setFormMode("closed");
            await refreshList();
          }
        } else if (formMode === "edit" && selectedScheduleId && detail) {
          // Project choice locked per schedule: updates always carry the
          // schedule's bound projectId, so editing cannot re-scope it.
          const { projectId: _locked, ...patch } = input;
          void _locked;
          const result = await updateSchedule(commands, selectedScheduleId, detail.projectId, {
            name: patch.name.trim(),
            prompt: patch.prompt.trim(),
            kind: patch.kind,
            ...(typeof patch.intervalMs === "number" ? { intervalMs: patch.intervalMs } : {}),
            ...(typeof patch.delayMs === "number" ? { delayMs: patch.delayMs } : {}),
            ...(patch.runAt ? { runAt: patch.runAt } : {}),
            ...(patch.dailyTime ? { dailyTime: patch.dailyTime } : {}),
            ...(typeof patch.weekday === "number" ? { weekday: patch.weekday } : {}),
            ...(typeof patch.hour === "number" ? { hour: patch.hour } : {}),
            ...(typeof patch.minute === "number" ? { minute: patch.minute } : {}),
            timezone: patch.timezone.trim(),
            overlap: patch.overlap,
            missedPolicy: patch.missedPolicy,
          });
          if (!result.ok) {
            setFormError(result.error);
          } else {
            setFormMode("closed");
            await refreshAll();
          }
        }
      } finally {
        setFormBusy(false);
      }
    },
    [commands, formMode, selectedScheduleId, detail, refreshList, refreshAll],
  );

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
    await refreshAll();
  }, [pendingPermissions, onResolvePermission, refreshAll]);

  const handleDenyPermission = useCallback(async () => {
    const first = pendingPermissions[0];
    if (!first || !onResolvePermission) return;
    setApprovalBusy(true);
    try {
      await onResolvePermission(first.id, "denied", "deny");
    } finally {
      setApprovalBusy(false);
    }
    await refreshAll();
  }, [pendingPermissions, onResolvePermission, refreshAll]);

  const grouped = useMemo(() => groupSchedules(schedules), [schedules]);
  const enabledCount = useMemo(() => countEnabledSchedules(schedules), [schedules]);

  // Timeline: existing activity projections filtered to task transitions.
  const scheduleTimeline = useMemo(
    () => taskActivity.filter((e) => e.kind === "task"),
    [taskActivity],
  );
  void scheduleTimeline;

  const createInitial: ScheduleFormInput = useMemo(
    () => ({ ...EMPTY_FORM, projectId: activeProjectId ?? "" }),
    [activeProjectId],
  );
  const editInitial: ScheduleFormInput | null = useMemo(() => {
    if (!detail) return null;
    return {
      name: detail.name,
      projectId: detail.projectId,
      prompt: detail.prompt,
      kind: detail.schedule.kind,
      intervalMs:
        detail.schedule.kind === "interval" ? (detail.schedule.intervalMs ?? 3_600_000) : 3_600_000,
      delayMs:
        detail.schedule.kind === "delay" ? (detail.schedule.delayMs ?? 3_600_000) : 3_600_000,
      runAt: detail.schedule.kind === "once" ? (detail.schedule.runAt ?? "") : "",
      dailyTime:
        detail.schedule.kind === "daily" ? (detail.schedule.dailyTime ?? "09:00") : "09:00",
      weekday: detail.schedule.kind === "weekly" ? (detail.schedule.weekday ?? 1) : 1,
      hour: detail.schedule.kind === "weekly" ? (detail.schedule.hour ?? 9) : 9,
      minute: detail.schedule.kind === "weekly" ? (detail.schedule.minute ?? 0) : 0,
      timezone: detail.timezone,
      overlap: detail.overlap,
      missedPolicy: detail.missedPolicy,
      enabled: detail.enabled,
    };
  }, [detail]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pt-4">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Schedules{enabledCount > 0 ? ` (${enabledCount} enabled)` : ""}
        </p>
        <div className="flex items-center gap-2">
          {onToggleScope && (
            <button
              type="button"
              onClick={() => onToggleScope(!scopeAllProjects)}
              aria-pressed={scopeAllProjects}
              title="Project switching never re-scopes a schedule: rows always show the bound project."
              className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              {scopeAllProjects ? "All projects" : "This project"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setFormMode(formMode === "create" ? "closed" : "create")}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white"
          >
            {formMode === "create" ? "Close form" : "New schedule"}
          </button>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            Refresh
          </button>
        </div>
      </div>
      {bridgeAbsent && (
        <p className="text-[11px] text-slate-500 px-6 pt-2">
          Schedules IPC is not available yet — showing local state. The center re-queries
          automatically once the schedules bridge lands.
        </p>
      )}
      {loading ? (
        <p className="text-xs text-slate-500 px-6 py-4">Loading schedules…</p>
      ) : (
        <div className="px-6 pb-2">
          {refreshError && (
            <p role="alert" className="text-rose-300 text-xs mt-2">
              {truncateText(refreshError, 500)}
            </p>
          )}
          {formMode === "create" && (
            <ScheduleForm
              initial={createInitial}
              projectLocked={false}
              busy={formBusy}
              formError={formError}
              onSubmit={(input) => void handleSubmitForm(input)}
              onCancel={() => {
                setFormMode("closed");
                setFormError(null);
              }}
            />
          )}
          {schedules.length === 0 && !refreshError ? (
            <p className="text-xs text-slate-500 py-4">
              No schedules{scopeAllProjects ? "" : " in this project"} yet.
            </p>
          ) : (
            <>
              <section aria-label="Enabled schedules">
                {grouped.enabled.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">No enabled schedules.</p>
                ) : (
                  <ScheduleGroup
                    label="Enabled"
                    schedules={grouped.enabled}
                    selectedScheduleId={selectedScheduleId}
                    onSelectSchedule={onSelectSchedule}
                  />
                )}
              </section>
              <section aria-label="Disabled schedules" className="mt-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-1">
                  Disabled ({grouped.disabled.length})
                </p>
                {grouped.disabled.length === 0 ? (
                  <p className="text-xs text-slate-500 py-1">Nothing disabled.</p>
                ) : (
                  <ScheduleGroup
                    label="Disabled"
                    schedules={grouped.disabled}
                    selectedScheduleId={selectedScheduleId}
                    onSelectSchedule={onSelectSchedule}
                  />
                )}
              </section>
            </>
          )}
          {detail && (
            <>
              <ScheduleDetail
                schedule={detail}
                runs={runs}
                pendingApprovalCount={pendingPermissions.length}
                onApprovePermission={onResolvePermission ? handleApprovePermission : null}
                onDenyPermission={onResolvePermission ? handleDenyPermission : null}
                approvalBusy={approvalBusy}
                actionError={actionError}
                actionBusy={actionBusy}
                onRunNow={() => void handleRunNow()}
                onToggleEnabled={() => void handleToggleEnabled()}
                onDelete={() => void handleDelete()}
                onEdit={() => {
                  setFormMode("edit");
                  setFormError(null);
                }}
                onClose={() => onSelectSchedule(null)}
                onRefresh={() => void refreshDetailAndRuns()}
              />
              {formMode === "edit" && editInitial && (
                <ScheduleForm
                  initial={editInitial}
                  projectLocked
                  busy={formBusy}
                  formError={formError}
                  onSubmit={(input) => void handleSubmitForm(input)}
                  onCancel={() => {
                    setFormMode("closed");
                    setFormError(null);
                  }}
                />
              )}
            </>
          )}
          <p className="text-[10px] text-slate-500 px-1 mt-2">
            Manual runs are labeled Manual in history. Deleting a schedule does not cancel any
            running task.
          </p>
        </div>
      )}
    </div>
  );
}
