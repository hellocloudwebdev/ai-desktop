# ADR-016: Scheduling & Autonomous Tasks — Renderer + Docs Layer

- **Status:** Accepted (renderer + docs scope only)
- **Date:** 2026-09-18

## Context

PR44 splits Scheduling & Autonomous Tasks into three parallel
workstreams: (a) the ai-core `schedules.ts` contracts + agent-runtime
scheduling core, (b) the desktop `SchedulerService` + `schedules:*` IPC +
preload + storage/prisma persistence, and (c) this renderer + docs layer.
The renderer must display autonomous schedules without owning any of them,
and must keep working — rendering an honest empty state — before the
sibling runtime/IPC lands. PR43 established the pattern this layer mirrors:
a narrow `window.api.*` bridge client probed with optional chaining, pure
normalize/unwrap/group/truncate/redact helpers, a local-stub fallback with
IPC-shaped envelopes and legal behavior, a self-contained center that
re-queries on mount/scope change plus a single bounded poll, approval
through the existing permission UI path with no auto-approval, and
display-only project isolation.

## Decision

**Schedules vs background tasks.** Background tasks (PR43) are
already-queued units of work with a nine-state lifecycle the renderer
groups Active vs Completed. Schedules are recurrence definitions that
produce runs: a schedule has a name, a bound project, a prompt, an enabled
flag, a timezone, a kind-specific config (interval / once / daily), an
overlap policy, and a missed-run policy. One Schedule Center shows all of
them — the Enabled section ordered by next run (soonest first), the
Disabled section ordered by recency — on the existing `"tasks"` surface
(`SCHEDULE_CENTER_SURFACE`) alongside the Task Center, because operators
triage "what will fire" and "what fired" in one place. No new workspace
surface kind, no store/persistence change.

**Projection-vs-events semantics.** The renderer consumes `ScheduleView`
snapshots (scheduleId/projectId/name/prompt/enabled/timezone/schedule/
scheduleDescription/overlap/missedPolicy/createdAt/updatedAt/nextRunAt/
lastRunAt/lastRunStatus) and `ScheduleRunView` snapshots
(runId/scheduleId/projectId/status/trigger/createdAt/startedAt/finishedAt/
errorSnippet/taskId) through a narrow `window.api.schedules`
list/get/create/update/enable/disable/delete/runNow/runs client with
optional chaining and a local-stub fallback. Run transitions surface
through the existing EventBus/activity projections and the per-schedule
`runs` history — there is intentionally no separate notification bus. The
renderer holds no source of truth: it re-queries on mount, on scope
change, and on a single bounded 2 s poll, so remounts and disconnects
recover by re-fetching. Persistence owns durability; events own history;
the renderer owns neither.

**Lifecycle.** A schedule is a definition, not a run: create validates
fully client-side first, then the bridge persists; update patches the
definition (the bound project is never sent back); enable arms future
ticks and recomputes the next run; disable parks future ticks and clears
the displayed next run; delete removes the definition only. Deleting a
schedule explicitly does not cancel any running task — runs already
launched keep their own lifecycle behind the background-task bridge, and
run history stays queryable after the definition delete. Run now launches
exactly one manual run, always labeled Manual in history. Nothing executes
from a partial form: the submit button stays disabled until
`validateScheduleForm` reports zero errors, and the submit handler
re-checks validity before any bridge call.

**Schedule kinds and timezones.** Three kinds only: `interval`
(`intervalMs`, minimum 1 minute), `once` (`runAt`, a parseable
timestamp), and `daily` (`dailyTime` as 24-hour `HH:MM`). There is no cron
kind — cron expressions are a non-goal. Every schedule carries an IANA
timezone (validated via `Intl.DateTimeFormat`, defaulting to `UTC` when
the bridge omits it); the renderer displays the timezone verbatim and
formats next/previous runs in local time without reinterpreting them.
Human-readable descriptions (`Every 5m`, `Once at …`, `Daily at 09:00`)
derive purely when the bridge omits `scheduleDescription`.

**Missed-run policy (default skip).** Ticks missed while the app was down
default to `skip` for recurring schedules: at most `MAX_SCHEDULE_CATCH_UP
= 1` missed tick is caught up once, the rest are skipped. One-shot (`once`)
schedules use `run_once`: the single deferred firing still runs once when
recovery permits. The renderer displays the policy verbatim and never
decides catch-up itself.

**Overlap policy (default skip).** A tick that fires while the previous
run from the same schedule is still active defaults to `skip` (the tick is
dropped); `queue_one` parks exactly one deferred firing for the next free
slot. The renderer displays the policy (`queue_one` as `queue`); queueing
depth and preemption stay main-side.

**Recovery (idempotent).** The renderer displays recovery outcomes; it
never decides them (classification and catch-up live main-side, executed
by the scheduler). Catch-up launches carry the canonical `recovery`
trigger, rendered with the Recovered label. Recovery never auto-replays
non-idempotent tools and never auto-approves permissions: a launched run
whose background task hits the permission checkpoint parks downstream
until a human acts. The detail re-query after recovery shows the new
previous run rather than resurrecting stale state.

**Permission behavior (schedule≠grant).** A schedule is never a grant.
Background tasks launched from schedules — via scheduled, manual, or
recovery triggers — pass the existing permission checkpoint exactly like
any other run: when approval is required, the run's task parks downstream
and the surface renders a "Schedule run requires approval" banner resolved
exclusively through the existing permission UI path (`pendingPermissions`

- `onResolvePermission`, i.e. the same `resolvePermission` checkpoint as
  Chat). The surface never auto-approves, never invents an approval channel,
  and manual Run now confers no privilege: it only enqueues a run that still
  checkpoints.

**Caps (32/8/1min/50/1-catch-up).** At most 32 schedules workspace-wide;
at most 8 schedule-triggered runs concurrently active (shared with the
background-task pool so schedules cannot starve supervised work); minimum
1-minute interval between recurring ticks (sub-minute rejected at
validation); 50 rendered rows per Enabled/Disabled section and 50 rendered
run-history rows (the store stays authoritative for full history); at most
1 missed tick caught up after downtime. The renderer mirrors these budgets
as constants and render caps; enforcement lives main-side.

**Project isolation.** Rows always render the schedule's (and each run's)
bound `projectId`; filtering ("This project" vs "All projects") and
workspace project switching never rewrite it. Belt-and-braces: even if the
bridge returns unscoped data, the renderer filters before display, so no
cross-project leakage reaches the screen. The project choice is locked per
schedule: the edit form disables the project field, and update never sends
a project rewrite.

**Run identity.** Every run carries a stable `runId` plus its parent
`scheduleId`, bound `projectId`, canonical status
(pending/running/completed/failed/skipped/cancelled), and trigger
(scheduled/manual/recovery). History sorts newest first; manual runs are
always labeled Manual; scheduled and recovery runs keep their own labels
so "who launched this" is never ambiguous. An optional `taskId` links a
run to its background-task execution without merging the two lifecycles
(delete≠cancel depends on this separation).

**Exactly-once limitations.** Persistence records intent, not external
side effects: a crash between a tick firing and its run commit leaves
genuine uncertainty. Therefore the renderer (a) never auto-replays
anything, (b) renders recovery-triggered/uncertain runs as history with
their true trigger rather than restarting them, and (c) documents that
intent ≠ side effect — uncertain operations are never auto-retried by UI
affordance, and the single catch-up bound exists precisely to avoid
duplicate side effects.

**Hygiene.** `key=value`-shaped secret material (API keys, tokens,
passwords, bearer credentials) is redacted before render; plain prose
that merely mentions these words passes through. Names bound at ≤120,
prompts at ≤4000. No renderer Node/Electron APIs, no spawned processes,
no Prisma, no raw runtime internals, no raw HTML. No new dependencies.

## Non-goals

Cron expressions, cloud workers/schedulers, push notifications,
multi-user collaboration and sharing, schedule marketplace/templates,
auto-update/auto-push of schedule definitions, schedule execution policy
tuning beyond the documented overlap/missed knobs, and the
runtime/persistence/IPC slices themselves (sibling workstreams). This ADR
constrains only the renderer + docs layer, which activates against the
sibling bridge with no further renderer change.

## Consequences

- The Schedule Center works pre-landing (stub-backed empty state) and
  post-landing (bridge probe activates automatically) with zero migration.
- `desktop → ai-core` gains no new edge (renderer-local view types only);
  the locked dependency graph is untouched; no package gains a dependency.
- Approval UX stays single-pathed: one permission checkpoint for chat,
  foreground agents, background agents, and scheduled runs alike.
- Delete-means-definition-only is explicit in the UI, so operators never
  mistake removing a schedule for cancelling in-flight work.
