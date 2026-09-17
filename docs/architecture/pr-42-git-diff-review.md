# PR42 — Git Diff & Review Foundation

## 1. Objective

PR42 gives the PR41 Coding Workspace a local-Git review layer — detect,
status, diff, log, branches, stage/unstage, commit — reusing the PR30
path policy, PR24 PermissionManager, the single ToolExecutor lifecycle
(CONSTITUTION §6.1), and typed IPC. No second agent loop, permission
system, executor, EventBus, remote transport, or hosting integration.

```text
GitReviewSurface (status / diff / log / branches / stage / commit review UI)
   ↓
typed preload
   ↓
typed IPC (git:* — 8 channels, no git:execute)
   ↓
desktop git services (GitService over GitCliClient)
   ↓
PR30 path policy (resolveWorkspacePath + assertNoSymlinkEscape)
   ↓
PermissionManager (git capability — tools enforce; IPC stays thin)
   ↓
single authoritative project git repo (project-scoped, re-detected per call)
```

Agent path (no second runtime): Agent Runtime → ToolRegistry →
`GitToolExecutor` (validate → permission → service) → `GitService`.
UI path: `GitReviewSurface` → preload → `git:*` IPC → `GitService`.
Both paths converge on the same `GitService` + `GitCliClient` boundary.

---

## 2. Canonical contracts (`@ai-desktop/ai-core` — `git.ts`)

Pure domain module, zero Electron/Prisma/`child_process`/Git CLI imports:

- Branded `GitReviewId` / `GitReviewCommentId` (Crockford Base32 ULID,
  upper-cased) for future review/comment objects; `GIT_COMMIT_SHA_PATTERN`
  (`^[0-9a-fA-F]{7,64}$`) for short/full SHAs.
- Domain models: `GitRepository` (isRepo/rootPath/currentBranch/detached/
  headSha/empty), `GitBranch`, `GitRemote`, `GitStatus` (+ per-file
  workingTree/index kinds, staged/conflicted flags, staged/unstaged/
  untracked/conflicted counts), `GitDiff` (per-file hunks with
  context/add/del lines, additions/deletions, `truncated` flag),
  `GitCommit`/`GitLog` (author, message, summary, parents).
- Error taxonomy (`GitErrorCodeSchema`): `not-a-repo`,
  `path-outside-workspace`, `symlink-escape`, `invalid-path`,
  `nothing-staged`, `nothing-to-commit`, `commit-failed`,
  `command-failed`, `timeout`, `cancelled`, `permission-denied`,
  `empty-commit-message`. Desktop maps these to `GitServiceErrorCode`
  (`apps/desktop/src/main/git/git-errors.ts`) via `toCanonicalGitError`
  — serializable code + message, never absolute main-side paths.
- Untrusted-content framing: `UNTRUSTED_GIT_CONTENT_HEADER` +
  `frameGitDiffContent` / `frameGitCommitMessage` (repo/file/sha-tagged
  data-not-instructions wrappers for any agent-consumed diff/commit text).
- 7 canonical tools (`GIT_TOOL_IDS`): `builtin:git.status`,
  `builtin:git.diff`, `builtin:git.log`, `builtin:git.branches`,
  `builtin:git.stage`, `builtin:git.unstage`, `builtin:git.commit` —
  each with Zod input schema, `gitToolParameters`, `gitToolDescription`,
  `requiredPermissions: ["git"]`, and `gitRiskFor` mapping (§5).
  There is deliberately **no** `builtin:git.discard` — discard is a
  destructive service-only operation, not an agent tool.

---

## 3. Desktop execution boundary

### 3.1 `GitCliClient` (`apps/desktop/src/main/git/git-cli.ts`)

The only place a `git` binary is spawned:

- `spawn(gitBinary, args[], { cwd, env, shell: false, stdio: ["ignore",
"pipe", "pipe"] })` — argv arrays only, **never a shell**, so
  shell-metachar paths/branches/messages are passed literally.
- Forced non-interactive env: `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`,
  `GIT_OPTIONAL_LOCKS=0`; caller env is **not** inherited — only the
  allowlist (`PATH`, `Path`, `SYSTEMROOT`, `SystemRoot`, `TEMP`, `TMP`,
  `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) is copied through.
  No secrets are read or forwarded.
- Bounded stdout/stderr (`maxBufferBytes = GIT_MAX_DIFF_BYTES`,
  over-limit kills with `SIGKILL` and rejects `COMMAND_FAILED`),
  per-command timeout (default `GIT_COMMAND_TIMEOUT_MS`, `SIGKILL` →
  `TIMEOUT`), and `AbortSignal` cancellation (`CANCELLED`, pre-start
  fail-closed).
- Deterministic machine-parsed output only: porcelain v1 status
  (`status --porcelain=v1 -uall`), unified diff (`diff --no-color -p`
  / `--cached`), `%x1f`/`%x1e`-delimited log, `--format=` branch lines.
  Parsers (`parseStatus` / `parseDiff` / `parseLog` / `parseBranches`)
  enforce the §5 bounds and truncate with flags instead of growing
  unbounded.

### 3.2 `GitService` (`apps/desktop/src/main/git/git-service.ts`)

ProjectId-first orchestration over `GitCliClient` + PR30 path policy:

- `_requireWorkspace` resolves the project root per call; unknown
  projects fail closed (`NO_WORKSPACE`). `_validatePaths` runs every
  user-supplied path through `resolveWorkspacePath` +
  `assertNoSymlinkEscape` (traversal → `PATH_OUTSIDE_WORKSPACE`,
  symlink escape → `SYMLINK_ESCAPE`), capped at `GIT_MAX_STAGE_PATHS`.
- `detectRepository` (`rev-parse --is-inside-work-tree` /
  `--show-toplevel` / `--abbrev-ref HEAD` / `rev-parse HEAD`) —
  non-repos return `{ isRepo: false }`, never a crash; reports
  `currentBranch`, `detached`, `headSha`, `empty`.
- `getStatus` re-detects then parses porcelain status plus upstream
  (`rev-parse @{upstream}`, `rev-list --left-right --count`); non-repos
  return a clean `isRepo: false` envelope.
- `getDiff` (`--cached` for staged, `-- <validated-path>` for
  single-file), `getLog` (clamped limit, empty-repo → `{ commits: [],
total: 0 }`, no-commit history handled), `getBranches` (tracking +
  ahead/behind parsing).
- `stage` (`add -A -- <paths>`), `unstage` (`restore --staged`, fallback
  `reset HEAD --`), `commit` (trim + empty-reject + byte-cap check,
  `NOTHING_STAGED` guard via fresh `getStatus`, `commit -m`, returns new
  `commitSha` via `rev-parse HEAD`).
- `discard` — **destructive, service-only** (no tool ID, no `git:*`
  channel): unstage-first (best-effort), `restore -- <paths>`, then
  unlink only `lstat`-verified files/symlinks whose fresh porcelain
  state is `??` (untracked). Never deletes directories. UI-gated, never
  agent-invoked.

### 3.3 `GitToolExecutor` (`apps/desktop/src/main/git/git-tool-executor.ts`)

Universal lifecycle, same as every tool (CONSTITUTION §6.1):
`resolve → Zod validate → PermissionManager check → GitService dispatch`.
Validates the input schema **before** the permission check; capability
`git`, action per tool, resource `git::<projectId>::<action>`, risk from
`gitRiskFor`; denials return `isError: true` `ToolResult` (never throw
through policy). Outcomes serialize to bounded JSON; errors return
`[CODE] message` via `toCanonicalGitError`.

---

## 4. IPC, preload, `GitReviewSurface`

Thin `git:*` handlers following the `workspace:*` pattern (Zod schemas in
`@ai-desktop/shared` validate before any handler runs; **no**
`PermissionManager` call in IPC — agent _tools_ enforce permissions).
Every channel carries `projectId`; payloads are bounded by the §5 limits;
error envelopes carry codes, never absolute main-side paths.

| #   | Channel        | Direction | Payload (bounded)               | Service method     |
| --- | -------------- | --------- | ------------------------------- | ------------------ |
| 1   | `git:detect`   | invoke    | `{ projectId }`                 | `detectRepository` |
| 2   | `git:status`   | invoke    | `{ projectId }`                 | `getStatus`        |
| 3   | `git:diff`     | invoke    | `{ projectId, staged?, path? }` | `getDiff`          |
| 4   | `git:log`      | invoke    | `{ projectId, limit? }`         | `getLog`           |
| 5   | `git:branches` | invoke    | `{ projectId }`                 | `getBranches`      |
| 6   | `git:stage`    | invoke    | `{ projectId, paths[] }`        | `stage`            |
| 7   | `git:unstage`  | invoke    | `{ projectId, paths[] }`        | `unstage`          |
| 8   | `git:commit`   | invoke    | `{ projectId, message }`        | `commit`           |

There is intentionally **no** `git:execute`, `git:discard`, `read-path`,
or shell channel — execution flows through the agent tool router, and
discard stays a UI-gated service call. The preload bridge exposes only
these 8 typed invokes; `GitReviewSurface` (status list, file diff viewer
with hunks, log/branches panels, stage/unstage/commit controls with
dirty + conflict UX) calls them and re-reads after every mutation, so
external changes (terminal, IDE, agent tools) appear on the next
refresh. Renderer code holds no Node/Electron/fs/`child_process`
access — privileged work crosses preload IPC only.

Events: no new event types. Git activity surfaces through the existing
streams — `tool.call.*` (executor lifecycle) and `permission.*`
(check/request/decision) — with the AIEvent union untouched.

---

## 5. Security model, permissions, isolation, limits

- **Project scoping:** every op carries project context; unknown
  projects rejected at the resolver (`NO_WORKSPACE`); cross-project
  access impossible — `cwd` is always the resolved workspace root.
- **Path policy:** all user paths via `resolveWorkspacePath` +
  `assertNoSymlinkEscape` (traversal/absolute/symlink/nested-symlink
  rejected; sentinel-file tested per PR30 convention).
- **No shell:** argv-only `spawn` (`shell: false`, `stdio` ignore/pipe/
  pipe); non-interactive flags prevent credential/merge-prompt hangs.
- **Env allowlist:** only `PATH`/`Path`/`SYSTEMROOT`/`SystemRoot`/`TEMP`/
  `TMP`/`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` pass through plus
  forced `GIT_TERMINAL_PROMPT=0`/`LC_ALL=C`/`GIT_OPTIONAL_LOCKS=0`.
- **No secrets:** git commands never receive credentials; error paths
  (`toCanonicalGitError`) strip absolute paths, stack traces, and env.
- **Permission classification** (`gitRiskFor`, capability `git`):

  | Class       | Ops                                     | Risk               | Path                                                                   |
  | ----------- | --------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
  | Read        | detect / status / diff / log / branches | `low`              | IPC + (except detect) agent tools                                      |
  | Mutate      | stage / unstage / commit                | `medium`           | IPC + agent tools (approval-gated)                                     |
  | Destructive | discard                                 | n/a (service-only) | UI-gated service call — **not a tool**, no tool ID, no `git:*` channel |

- **Bounds** (single source of truth: `packages/ai-core/src/git.ts`):

  | Constant                   | Value            | Guards                                          |
  | -------------------------- | ---------------- | ----------------------------------------------- |
  | `GIT_MAX_STATUS_FILES`     | 2000             | status file list                                |
  | `GIT_MAX_DIFF_FILES`       | 200              | diff file list                                  |
  | `GIT_MAX_DIFF_BYTES`       | 1 048 576 (1 MB) | CLI stdout/stderr buffers + diff payload        |
  | `GIT_MAX_DIFF_LINES`       | 10000            | total diff lines                                |
  | `GIT_MAX_HUNK_LINES`       | 1000             | lines per hunk                                  |
  | `GIT_MAX_LOG_ENTRIES`      | 100              | log entries (default page 20)                   |
  | `GIT_MAX_BRANCHES`         | 200              | branch list                                     |
  | `GIT_MAX_COMMIT_MSG_BYTES` | 32768 (32 KB)    | commit message                                  |
  | `GIT_MAX_STAGE_PATHS`      | 500              | stage/unstage path arrays                       |
  | `GIT_COMMAND_TIMEOUT_MS`   | 30000 (30 s)     | default CLI timeout (detect fast-paths use 5 s) |

- **Operational limits:** output ceilings kill-and-reject (never
  truncate silently at the transport); timeouts `SIGKILL` and report
  `TIMEOUT`; `AbortSignal` cancellation is first-class and idempotent;
  oversized payloads rejected at schema + service bounds.
- **Isolation + external-change refresh:** no cached repo snapshot —
  `detectRepository` runs per operation and `getStatus`/`getDiff`/
  `getLog` re-read from the CLI, so out-of-band changes win on next
  refresh (same "disk wins until user decides" posture as PR41 editor
  conflicts); non-repo workspaces degrade to `isRepo: false` UI instead
  of errors, while mutating ops throw `NOT_A_REPO`.

---

## 6. Non-goals and future extension points

Non-goals (explicitly out of PR42): push/pull/fetch/merge UI or any
network transport, GitHub/hosting integration, worktrees/submodules/
LFS management, a second agent loop, a second permission system or
executor, new EventBus/event types, or an unrestricted shell channel.
Gates: `architecture:check`, `typecheck`, `lint`, `test`, `build`,
`format:check` — zero new dependencies, zero dependency-graph edge
changes (desktop already depends on `ai-core`/`shared`/`permissions`).

Not implemented — reserved extension points: inline per-hunk review
comments (`GitReviewId`/`GitReviewCommentId` branded IDs already
reserved in `ai-core`), AI-generated review summaries over framed
(untrusted) diff content, and PR/remote integration built on the same
`GitService` → `git:*` IPC → `GitReviewSurface` layering.
