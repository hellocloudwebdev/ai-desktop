// PR33.9: renderer — Rich Surface Commands Bridge
//
// Narrow access to the PR33 surface commands exposed on window.api.commands
// by the preload (listSurfaces/getSurface/invokeSurfaceAction/disposeSurface).
// Results stay unknown until normalized into SurfaceView records. An absent
// bridge (non-Electron hosts, tests without window) yields empty results,
// never a crash.
//
// PR43: renderer — the background-task bridge lives in
// `./background-tasks.js` (window.api.backgroundTasks list/get/start/
// pause/resume/cancel/respond with a local-stub fallback) and is
// re-exported here so the Task Center has one workspace import surface.
//
// PR44: renderer — the schedules bridge lives in `./schedules.js`
// (window.api.schedules list/get/create/update/enable/disable/delete/
// runNow/runs with a local-stub fallback) and is re-exported here so the
// Schedule Center has one workspace import surface.

export * from "./background-tasks.js";
// PR44: explicit schedule re-exports (no `export *`: `truncateText` and
// `redactSecretAssignments` already come from `./background-tasks.js` with
// identical semantics; the schedule-specific truncation helpers below mirror
// them without re-exporting the colliding generics).
export {
  MAX_CONCURRENT_SCHEDULE_RUNS,
  MAX_SCHEDULES_TOTAL,
  MAX_SCHEDULE_CATCH_UP,
  MAX_SCHEDULE_DISPLAY_NAME,
  MAX_SCHEDULE_DISPLAY_PROMPT,
  MAX_SCHEDULE_ROWS_PER_SECTION,
  MAX_SCHEDULE_RUNS_SHOWN,
  MIN_SCHEDULE_INTERVAL_MS,
  MISSED_POLICIES,
  OVERLAP_POLICIES,
  SCHEDULE_KINDS,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_RUN_TRIGGERS,
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
  isMissedPolicy,
  isOverlapPolicy,
  isScheduleFormValid,
  isScheduleKind,
  isScheduleRunStatus,
  isScheduleRunTrigger,
  isValidTimezone,
  normalizeScheduleRunView,
  normalizeScheduleRunViews,
  normalizeScheduleView,
  normalizeScheduleViews,
  runScheduleNow,
  scheduleRunStatusBadgeClass,
  scheduleRunStatusLabel,
  scheduleTriggerLabel,
  truncateScheduleName,
  truncateSchedulePrompt,
  unwrapSchedule,
  unwrapScheduleList,
  unwrapScheduleRuns,
  updateSchedule,
  validateScheduleForm,
} from "./schedules.js";
export type {
  GroupedSchedules,
  LocalScheduleSeed,
  MissedPolicy,
  OverlapPolicy,
  ScheduleCommandResult,
  ScheduleCommands,
  ScheduleConfig,
  ScheduleFormErrors,
  ScheduleFormInput,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduleRunView,
  ScheduleView,
} from "./schedules.js";

import type { SurfaceView } from "../components/workspace/surfaces/surface-props.js";

interface SurfaceCommands {
  listSurfaces(args?: { projectId?: string }): Promise<unknown>;
  getSurface(args: { instanceId: string }): Promise<unknown>;
  invokeSurfaceAction(args: {
    instanceId: string;
    actionId: string;
    input?: unknown;
    projectId?: string;
  }): Promise<unknown>;
  disposeSurface(args: { instanceId: string }): Promise<unknown>;
}

function getSurfaceCommands(): SurfaceCommands | null {
  try {
    if (typeof window === "undefined") return null;
    const api = window.api as unknown as { commands?: Record<string, unknown> } | undefined;
    const commands = api?.commands;
    if (!commands) return null;
    const names = ["listSurfaces", "getSurface", "invokeSurfaceAction", "disposeSurface"];
    for (const name of names) {
      if (typeof commands[name] !== "function") return null;
    }
    return commands as unknown as SurfaceCommands;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unwrapValue(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.ok === true && "value" in raw) return raw.value;
  return raw;
}

/**
 * Accepts the list envelope ({ ok, value: { surfaces } } / { ok, value: [...] })
 * and returns candidate entries. Anything else yields [].
 */
export function unwrapSurfaceList(raw: unknown): unknown[] {
  const value = unwrapValue(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.surfaces)) return value.surfaces;
  return [];
}

/** Validates one unknown entry into a SurfaceView, or null when unusable. */
export function normalizeSurfaceView(item: unknown): SurfaceView | null {
  if (!isRecord(item)) return null;
  if (typeof item.instanceId !== "string" || item.instanceId.length === 0) return null;
  if (typeof item.kind !== "string" || item.kind.length === 0) return null;
  if (typeof item.status !== "string") return null;
  const provenance = isRecord(item.provenance) ? item.provenance : null;
  // Instances may arrive flattened (registry shape) or nested; accept both.
  const source =
    provenance && typeof provenance.source === "string"
      ? provenance.source
      : typeof item.source === "string"
        ? item.source
        : null;
  const originId =
    provenance && typeof provenance.originId === "string"
      ? provenance.originId
      : typeof item.toolName === "string"
        ? item.toolName
        : null;
  if (!source || !originId) return null;
  const actions: SurfaceView["actions"] = [];
  if (Array.isArray(item.actions)) {
    for (const entry of item.actions) {
      if (!isRecord(entry)) continue;
      if (typeof entry.actionId !== "string" || entry.actionId.length === 0) continue;
      if (typeof entry.type !== "string") continue;
      if (typeof entry.toolName !== "string") continue;
      actions.push({
        actionId: entry.actionId,
        type: entry.type,
        toolName: entry.toolName,
        title: asOptionalString(entry.title),
      });
    }
  }
  // Descriptor may arrive nested (descriptor: {...}) or flattened.
  const descriptor = isRecord(item.descriptor) ? item.descriptor : item;
  return {
    instanceId: item.instanceId,
    kind: typeof descriptor.kind === "string" ? descriptor.kind : item.kind,
    title: asOptionalString(descriptor.title ?? item.title),
    status: item.status,
    provenance: {
      source,
      originId,
      projectId:
        (provenance && asOptionalString(provenance.projectId)) ?? asOptionalString(item.projectId),
    },
    data: (item as Record<string, unknown>).data ?? (item as Record<string, unknown>).result,
    actions,
  };
}

/** Normalizes a candidate list, dropping entries that fail validation. */
export function normalizeSurfaceViews(items: readonly unknown[]): SurfaceView[] {
  const views: SurfaceView[] = [];
  for (const item of items) {
    const view = normalizeSurfaceView(item);
    if (view) views.push(view);
  }
  return views;
}

/** Lists surfaces through the real commands bridge. Absent bridge → []. */
export async function fetchSurfaceList(projectId?: string): Promise<SurfaceView[]> {
  const commands = getSurfaceCommands();
  if (!commands) return [];
  const raw = await commands.listSurfaces(projectId ? { projectId } : {});
  return normalizeSurfaceViews(unwrapSurfaceList(raw));
}

/** Fetches one instance snapshot. Absent bridge or unknown id → null. */
export async function fetchSurfaceInstance(instanceId: string): Promise<SurfaceView | null> {
  const commands = getSurfaceCommands();
  if (!commands) return null;
  const raw = await commands.getSurface({ instanceId });
  const value = unwrapValue(raw);
  const surface = isRecord(value) && "surface" in value ? value.surface : value;
  return normalizeSurfaceView(surface);
}

/** Invokes a surface action through the real commands bridge. */
export async function invokeSurfaceAction(
  instanceId: string,
  actionId: string,
  input: unknown,
  projectId?: string,
): Promise<unknown> {
  const commands = getSurfaceCommands();
  if (!commands) return;
  return commands.invokeSurfaceAction({
    instanceId,
    actionId,
    input,
    ...(projectId ? { projectId } : {}),
  });
}

/** Disposes a surface instance through the real commands bridge. */
export async function disposeSurfaceInstance(instanceId: string): Promise<unknown> {
  const commands = getSurfaceCommands();
  if (!commands) return;
  return commands.disposeSurface({ instanceId });
}
