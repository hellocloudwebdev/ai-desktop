# ADR-015: Background & Long-Running Agents — Renderer + Docs Layer

- **Status:** Accepted (renderer + docs scope only)
- **Date:** 2026-09-18

## Context

PR43 splits Background & Long-Running Agents into three parallel
workstreams: (a) the agent-runtime `BackgroundTaskManager`, (b) the desktop
`backgroundTasks.*` IPC + preload, and (c) this renderer + docs layer. The
canonical contracts already exist (`packages/ai-core/src/background-tasks.ts`:
`BackgroundTaskStatus`, `BackgroundTaskProjection`,
`BACKGROUND_EVENT_TYPES`, recovery dispositions, error taxonomy, secret
guard). The renderer must display long-running work without owning any of
it, and must keep working — rendering an honest empty state — before the
sibling runtime/IPC lands.

## Decision

**Foreground vs background.** Foreground tasks (PR29 agent, PR30 coding)
are supervised inline: start, watch the node checklist, cancel. Background
tasks outlive attention: they queue, park on permissions/input, pause, and
survive renderer remounts and app restarts. One Task Center shows both —
the foreground list unchanged on top (PR31 `TasksSurface`), the background
Active/Completed sections below (`BackgroundTaskCenter`) — because
operators triage "what needs me" (waiting_approval/input, failed) in one
place. No new workspace surface kind: the center lives on `"tasks"`
(`TASK_CENTER_SURFACE`), and selection reuses `activeTaskId`
(presentation-only; project switching still clears it).

**Projection-vs-events semantics.** The renderer consumes
`BackgroundTaskProjection` snapshots (taskId/projectId/title/status/mode/
timestamps/attempt/lastError/resultSummary/nodeCount/currentNode) through
a narrow `window.api.backgroundTasks`
list/get/start/pause/resume/cancel/respond client with optional chaining
and a local-stub fallback. Transitions (`started/queued/
waiting_permission/waiting_input/paused/resumed/completed/failed/cancelled/
recovered`) surface as `task.background.*` entries through the existing
EventBus/activity projections — there is intentionally no separate
notification bus. The renderer holds no source of truth: it re-queries on
mount, on scope change, and on a bounded poll, so remounts and disconnects
recover by re-fetching. Persistence owns durability; events own history;
the renderer owns neither.

**Recovery (resumable vs requires_approval vs abandoned).** The renderer
displays recovery outcomes; it never decides them (classification lives in
ai-core's `classifyRecovery`, executed by the manager). `resumable` tasks
re-enter the scheduler silently; `requires_approval` tasks render parked
(`paused`/`waiting_*`) until a human acts; terminal tasks render in
Completed and are never resurrected by the UI. The "Resume (re-queue)"
affordance routes a paused task through `queued`, never straight to
`running` — restart is a scheduler decision, not a renderer jump.

**Cancellation/pause.** Pause is cooperative and reversible (running →
paused → queued); cancel is downward-only and terminal (running →
cancelling → cancelled; queued/paused/waiting → cancelled directly).
Terminal tasks expose no action buttons. Every action reports bridge errors
as text; async UI work never throws.

**Permission-waiting.** A `waiting_permission` task renders a "Background
task requires approval" banner resolved exclusively through the existing
permission UI path (`pendingPermissions` + `onResolvePermission`, i.e. the
same `resolvePermission` checkpoint as Chat). The surface never
auto-approves, never invents an approval channel, and `respond` carries
only free-text answers for `waiting_input` tasks — never permission
decisions.

**Project isolation.** Rows always render the task's bound `projectId`;
filtering ("This project" vs "All projects") and project switching never
rewrite it. Belt-and-braces: even if the bridge returns unscoped data, the
renderer filters before display, so no cross-project leakage reaches the
screen.

**Failure semantics.** `failed` tasks keep a bounded error snippet
(≤2000 chars) and attempt count; `completed` tasks keep a result summary
(≤8000) with a result ref on the row; titles bound at ≤120. Sections cap
at 50 rendered rows, timelines at 100 entries — the store stays
authoritative for full history.

**Exactly-once limitations.** Persistence records intent, not external side
effects: a crash between a tool call and its event commit leaves genuine
uncertainty. Therefore the renderer (a) never auto-replays anything, (b)
renders `requires_approval` recoveries as parked rather than restarting
them, and (c) documents that intent ≠ side effect — uncertain operations
are never auto-retried by UI affordance.

**Hygiene.** `key=value`-shaped secret material (API keys, tokens,
passwords, bearer credentials) is redacted before render; plain prose that
merely mentions these words passes through. No renderer Node/Electron
APIs, no spawned processes, no Prisma, no raw runtime internals, no raw
HTML. No new dependencies.

## Non-goals (PR44+ territory)

Cloud workers, cron/scheduler triggers, multi-user collaboration, push
notifications, background execution policy tuning, and the manager/IPC
slices themselves (sibling workstreams). This ADR constrains only the
renderer + docs layer, which activates against the sibling bridge with no
further renderer change.

## Consequences

- The Task Center works pre-landing (stub-backed empty state) and
  post-landing (bridge probe activates automatically) with zero migration.
- `desktop → ai-core` gains no new edge (projection types only); the
  locked dependency graph is untouched; no package gains a dependency.
- Approval UX stays single-pathed: one permission checkpoint for chat,
  foreground agents, and background agents alike.
