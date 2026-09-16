# PR41 — Advanced Coding Workspace

## 1. Objective

PR41 turns the PR30 Coding Agent surface into an IDE-like project
workspace — explorer, editor with tabs, search, diagnostics, terminal,
diff — reusing the PR30 filesystem/execution contracts, PR27 Execution
Engine, PR31 Workspace shell, PermissionManager, EventBus, and typed IPC.
No second agent loop, filesystem, execution engine, permission system,
or EventBus.

```text
Workspace (Coding surface: explorer / editor / search / terminal / diff)
   ↓
typed preload
   ↓
typed IPC (workspace:* + terminal:* — no execute channel)
   ↓
desktop coding services (files / search / diagnostics / terminal)
   ↓
PR30 path policy + filesystem backend + PR27 ExecutionManager
   ↓
PermissionManager (filesystem.*/execution.run — tools enforce)
   ↓
single authoritative project filesystem
```

---

## 2. Editor (zero new dependencies)

No Monaco/CodeMirror/xterm was added (verified: none in the tree, and no
license/compat audit justified one). The editor is a dependency-free
textarea with a line-number gutter, Ctrl/Cmd+S save, tab bar with dirty
(●) and conflict ([external change]) indicators, revert, save-all,
10-tab cap, and duplicate-open prevention. Closing a dirty tab asks via
`window.confirm` (save/discard/cancel) — never silent loss.

Tabs and dirty state are renderer-local session state (not persisted to
localStorage — only PR31 layout persists); the filesystem stays
authoritative. Every save carries `expectedMtimeMs`; a mismatch yields
`EXTERNAL_MODIFIED` with reload/compare/keep-local UX instead of
overwriting agent/terminal changes.

---

## 3. Files, Search, Diagnostics, Diff

- `WorkspaceFileService`: projectId-first operations over
  `resolveWorkspacePath` (every path) + `filesystem-tool-backend`
  delegation. `listTree` (depth ≤4, 500/dir, 2000 total, symlink-dir
  skip, excluded dirs), `readFile` (NUL-probe binary rejection +
  mtimeMs capture), `writeFile` (conflict-checked), create/rename/
  delete (targetReal-only ops, root-delete refused, 1000-entry delete
  cap), `getStatus` for polling.
- `WorkspaceSearchService`: substring/case/whole-word (`\b`-escaped)/
  path-substring search with 1-based line/col, 50 default / 200 cap,
  256 KB + NUL skips, AbortSignal checks every 50 files, symlink-safe.
- `DiagnosticsService`: in-memory per-project store (report/list/clear,
  severity-ranked merge, 500/source cap with oldest-first eviction).
  No daemon; task-output adapters report in a later PR.
- `workspace-diff.ts`: pure bounded LCS diff (1 M-cell cap with
  `truncated` flag), 3-line-context hunks, `diffLines` +
  `toUnifiedString`. Workspace-level only — PR42 owns Git.

---

## 4. Terminal (sandboxed, stdin fail-closed)

`TerminalService` owns session lifecycle (`created → starting →
running → stopping → stopped`, plus `failed`/`cancelled`) with validated
transitions and idempotent cleanup, over `DefaultExecutionManager` +
`LocalProcessSandboxProvider` (same construction as the coding
executor). Sessions are project-scoped (8/project cap), cwd resolved
through the path policy, env fixed to the sandbox allowlist (no caller
env), output capped at 256 KB (tail-kept), timeouts default 30 s / cap
120 s, permission-checked (`execution`/`execute`, high risk) at create.

Interactive stdin is explicitly out of scope: `write()` throws
`STDIN_UNSUPPORTED` (tested) rather than faking a pty. Output is
polled (`terminal:output` tail snapshot), never streamed raw.
`shutdown()` stops all sessions (exported for app lifecycle wiring).

---

## 5. IPC, Permissions, Isolation, Security

- Channels: `workspace:files:list/read/write/create/rename/delete`,
  `workspace:search`, `workspace:diagnostics:report/list/clear`,
  `terminal:list/create/write/resize/stop/output` — all typed, projectId
  everywhere, bounded payloads. No `*:execute`, `read-path`, or shell
  channels (asserted). IPC performs path-policy enforcement; agent
  _tools_ enforce permissions (documented layering, pinned by test).
- Canonical tools unchanged (`builtin:filesystem.*`,
  `builtin:execution.run` + `CodingToolExecutor`).
- Isolation: every op carries project context; cross-project access
  rejected at the resolver (`NO_WORKSPACE`) and at terminal get/list.
- Security: traversal/absolute/symlink/nested-symlink/rename/delete
  escape tests with sentinel files; shell-metachar commands passed as
  argv (`shell:false`) and echoed literally; env secrets never
  inherited; error envelopes carry codes, never absolute main-side
  paths; oversized payloads rejected at schema + service bounds;
  renderer source-asserted free of Node/Electron/fs/child_process.
- E2E: create→open→edit→save→agent-read→agent-write→conflict-detect→
  command→output; project isolation (files + terminals); external-
  modification conflict (disk wins until user decides); diff hunks;
  search→open; diagnostics rank + clear.

---

## 6. Non-goals (PR42+ owns Git; no IDE replacement)

No LSP, debugger, profiler, Git client/branches/commits/worktrees,
marketplace, remote/collaborative editing, second runtimes, or
unrestricted shells. Gates: `architecture:check`, `typecheck`, `lint`,
`test`, `build`, `format:check` — zero new dependencies.
