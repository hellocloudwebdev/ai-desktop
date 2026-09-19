# ADR-017: Accounts & Cross-Device Sync — Renderer + Docs Layer

- **Status:** Accepted (renderer + docs scope only)
- **Date:** 2026-09-18

## Context

PR45 splits Accounts & Cross-Device Sync into three parallel
workstreams: (a) the ai-core accounts/sync contracts, (b) the
agent-runtime sync engine + session core, and (c) the desktop
`AccountService`/`SyncService` + `account:*`/`sync:*` IPC +
storage/prisma persistence, plus (d) this renderer + docs layer. The
renderer must display identity and sync state without owning either, and
must keep working — rendering an honest signed-out state — before the
sibling runtime/IPC lands. PR44 established the pattern this layer
mirrors: narrow `window.api.*` bridge clients probed with optional
chaining, pure normalize/unwrap/label/truncate/redact helpers, a
local-stub fallback with IPC-shaped envelopes and legal behavior, a
self-contained surface that re-queries on mount plus a single bounded
poll, and display-only isolation.

## Decision

**Identity model.** An account is a display projection: a session status
(`signed_out`/`authenticating`/`authenticated`/`refreshing`/`expired`/
`error`), a display name (≤120), and an optional identifier (email).
The renderer never sees, stores, or renders tokens, secrets, or
credentials — the session projection carries status and names only.
Sign-in carries a display name plus an optional identifier and validates
fully client-side first; nothing executes from a partial form. The
`expired` state renders a re-sign-in prompt with local-preservation
reassurance, never an automatic credential retry from the UI.

**Auth ≠ authz.** Authentication (who is signed in) is distinct from
authorization (what may execute). Signing in confers no capability: every
tool execution still passes the existing PR24 permission checkpoint, and
synced content arriving from another device is data, never a grant.
Schedules arriving via sync stay inert until their next lawful trigger
(see below); permissions, policies, and approvals are never auto-granted
by sync or by sign-in.

**SecretStore-only credentials.** Credentials live exclusively in the OS
keychain behind the PR9 `SecretStore` (`SecretRef`, never raw values in
SQLite, events, logs, error messages, or IPC payloads). The renderer
holds no secret material in any state, prop, or form default, and the
surface redacts `key=value`-shaped secret fragments before render (plain
prose that merely mentions these words passes through). Validation
rejects secret-shaped display names outright: identity fields must never
become a smuggling channel for pasted secrets.

**Device model.** Each installation is a named device (`deviceId`,
`deviceName`, platform, last-seen timestamp with relative display).
The surface shows the current device only — no device registry
management, no remote wipe, no device revocation UI. Those are explicit
non-goals; the renderer displays identity, it does not administer a
fleet.

**Syncable vs never-sync sets.** Syncable: memory facts, provider/model
preferences, and schedule definitions — user data that is safe to merge.
Never-sync: credentials and `SecretRef` targets, permission policies and
audit history, absolute filesystem paths, machine-local device records,
and raw event payloads containing secrets. Project binding travels as an
opaque project id; paths never sync (see below). The renderer mirrors
these sets as display categories only; enforcement lives main-side.

**Project binding: paths never sync.** Workspace roots are machine-local
facts. Sync carries project ids and content, never absolute paths; each
device re-anchors synced projects to its own local root through the PR30
path policy. The surface never renders local paths from remote records.

**Tombstones.** Deletes sync as tombstones, not as absence: a deleted
fact/schedule propagates a tombstone so a device that was offline does
not resurrect it on reconnect. The renderer never fabricates deletions;
it displays the merged result the bridge returns.

**LWW vs explicit conflicts.** Scalar preferences merge last-writer-wins
(displayed silently as the current value); structural conflicts (the same
memory fact or schedule edited on two devices) surface as explicit
`SyncConflictView` entries (entity, entity id, local vs remote versions,
changed fields) resolved only through Keep local / Keep remote buttons.
Conflicts are never resolved silently — there is no auto choice, no
default-on-timeout, and the UI states that conflicts are never resolved
automatically.

**Offline-first.** The local store is always usable: sign-out, offline
transports, and failed syncs degrade to local state with an honest
Offline/Needs-attention indicator, never a crash and never a wipe.
`startSync` while offline fails closed with text; `pause` parks sync on
this device only. The renderer re-queries on mount and on a single
bounded 2 s poll, so reconnects recover by re-fetching — no
renderer-local truth, no separate notification bus (sync transitions
surface through existing activity projections).

**Bounded retry.** Sync retries are bounded and main-side (bounded
attempts with backoff, then a parked error state the surface renders).
The renderer never retries itself: its only loop is the bounded display
poll, and every bridge failure surfaces as text.

**Untrusted-remote validation.** Synced content from another device is
untrusted input: it is validated main-side exactly like local input
(schema validation, secret scans, path-policy anchoring) before it
reaches any projection the renderer displays. The renderer additionally
redacts secret-shaped fragments at display time as belt-and-braces.

**Schedule-inert-on-arrival + no multi-device execution.** A schedule
that arrives via sync is inert data until the local scheduler adopts it
through its normal validated path; arrival never fires a run, and sync
never grants execution. Multi-device execution is fenced main-side (only
one device may hold the scheduler lease for a schedule); the renderer
displays sync status only and makes no execution decision. A schedule is
never a grant, on any device.

**Sign-out preserves local data.** Sign-out clears the session only.
Local projects, facts, and schedules stay on this device — the surface
states "Signing out preserves local projects on this device (delete ≠
wipe)". There is no renderer affordance that wipes local data; account
deletion (server-side) is a non-goal of this layer.

**Caps.** 50 rendered conflict rows (the store stays authoritative for
full history); display names ≤120. The renderer mirrors these budgets as
constants and render caps; enforcement lives main-side.

**Hygiene.** No renderer Node/Electron APIs, no spawned processes, no
Prisma, no network-auth code, no raw runtime internals, no raw HTML. No
new dependencies. The Account surface lives on a new `"account"` surface
id (`ACCOUNT_SURFACE`) — unlike PR43/PR44, which reused `"tasks"`,
because account identity is orthogonal to task triage — with no store
persistence change (the versioned localStorage schema already accepts
any surface member). The sidebar Account entry shows a dot when sync
needs attention (offline/error/conflict).

## Non-goals

Server-side OAuth/token flows, billing and entitlements, multi-user
collaboration and sharing, device fleet administration (remote wipe,
revocation), push notifications, automatic conflict auto-merge, cloud
execution workers, and the runtime/persistence/IPC slices themselves
(sibling workstreams). This ADR constrains only the renderer + docs
layer, which activates against the sibling bridges with no further
renderer change.

## Consequences

- The Account surface works pre-landing (stub-backed signed-out state)
  and post-landing (bridge probes activate automatically) with zero
  migration.
- `desktop → ai-core` gains no new edge (renderer-local view types
  only); the locked dependency graph is untouched; no package gains a
  dependency.
- Auth stays display-only in the renderer: one permission checkpoint for
  chat, agents, background work, scheduled runs, and synced content
  alike.
- Delete-means-session-only is explicit in the UI, so operators never
  mistake signing out for wiping local work.
