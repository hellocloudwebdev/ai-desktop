# PR30 — Coding Agent Foundation

## Scope

Build the first real Claude-Code-style coding workflow on top of the PR29 Agent
Runtime. The coding agent is a specialized consumer of the existing runtime, not
a second runtime: user request → CodingAgentService → PR29 AgentRuntime
(TaskGraph + per-node ReAct) → ToolRegistry → PermissionManager → ToolExecutor
→ filesystem/execution backends → canonical AIEvents → storage/projections →
renderer.

## Responsibilities

- `packages/ai-core/src/coding.ts`: canonical coding contracts
  (`CodingTaskRequest`, `CodingAgentContext`, tool IDs, capability/risk maps).
- `apps/desktop/src/main/agent/filesystem/`: workspace-aware path policy and
  bounded filesystem backend (list/search/read/write).
- `apps/desktop/src/main/agent/coding-tools.ts`: five canonical builtins with
  deterministic SHA-256 definition hashes and a validate → permission →
  backend executor.
- `apps/desktop/src/main/agent/coding-agent-service.ts`: desktop composition
  (request validation, workspace binding, runtime invocation, cancellation).
- Typed IPC (`coding:start/cancel/get/list`), preload bridge, renderer Coding
  popover.

## Tool definitions

| Tool ID                     | Source    | Runtime      | Capability          | Risk     |
| --------------------------- | --------- | ------------ | ------------------- | -------- |
| `builtin:filesystem.list`   | `builtin` | `in_process` | `filesystem.list`   | `low`    |
| `builtin:filesystem.search` | `builtin` | `in_process` | `filesystem.search` | `low`    |
| `builtin:filesystem.read`   | `builtin` | `in_process` | `filesystem.read`   | `low`    |
| `builtin:filesystem.write`  | `builtin` | `in_process` | `filesystem.write`  | `medium` |
| `builtin:execution.run`     | `builtin` | `execution`  | `execution.run`     | `high`   |

`execution` is a ToolRuntime, never a ToolSource. Command execution delegates
to `ExecutionManager` → `SandboxProvider`; the agent never calls Docker
directly. Definition hashes use the same convention as MCP discovery
(SHA-256 over name/description/parameters/runtime).

## Permission mappings

- Filesystem reads/list/search: capability `filesystem.*`, action `read`, risk
  `low`, resource `"<project>::read:<path>"`.
- Filesystem writes: capability `filesystem.write`, action `write`, risk
  `medium`, resource `"<project>::write:<path>"`.
- Command execution: capability `execution.run`, action `execute`, risk
  `high`, resource `"<project>::exec:<command>::cwd:<cwd>"`.
- Every call carries the real `toolCallId` so `allow_once` grants stay scoped.
- The runtime `PermissionGateway` (`tools.use`) runs first as the external
  blocked check; the executor's own check runs second. Both must allow.

## Filesystem boundary

`resolveWorkspacePath` normalizes, resolves (symlink-aware via `realpath`),
and proves containment against the resolved workspace root — never a string
prefix check. Missing-tail write targets resolve through the nearest existing
ancestor. Directory traversal skips symlinks; existing file symlinks resolve
and are rejected when they escape. Bounded limits: 64 KB read/write, 50
search results / 64 KB search bytes, 500 returned lines. Search excludes
`.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`
(documented in code) and never shells out to grep.

## Execution boundary

`builtin:execution.run` maps `{command, args, cwd, timeoutMs}` onto
`ExecutionRequest` (`mode: "sandboxed"`, timeout clamped to 120 s, default
30 s, `networkAllowed: false`). The workspace-relative `cwd` resolves through
path-policy to a real contained path before reaching the sandbox. The
`ExecutionManager` performs its own validation → permission → session →
sandbox sequence (`LocalProcessSandboxProvider` in the desktop singleton;
256 KB output ceiling, hard wall-clock timeout, allowlisted env).

## IPC boundary

`coding:start` (projectId required, workspaceRoot optional to register,
prompt, conversationId/modelId/maxNodeIterations optional),
`coding:cancel`, `coding:get` (status + node checklist), `coding:list`.
All validated with Zod in main before handlers run. Preload exposes only
`startCodingTask/cancelCodingTask/getCodingTask/listCodingTasks` — never
`ipcRenderer`, `fs`, `path`, or Electron.

## Event flow

No new event types: coding tasks reuse `task.*` (created/started/
subtask.created/node.started/node.completed/node.failed/blocked/replan/
completed/failed/cancelled) and `tool.call.*` (requested/started/completed/
failed). File changes surface as tool results, not event payloads — the event
stream never becomes a second filesystem.

## Cancellation

PR29 semantics reused: `cancelCodingTask` → task controller abort → node
controllers → tool/sandbox cancellation. Downward-only, idempotent,
exactly one terminal state.

## Security

- Workspace escape (traversal, absolute outside, symlink) rejected by
  path-policy; proven by 10 dedicated tests.
- Denied tools never reach backends (executor returns `isError` before
  dispatch); proven by executor tests.
- Tool errors fail the node visibly (`task.failed` carries the tool name);
  never silent, never crashing the process.
- Renderer has no Node/Electron/filesystem access; proven by boundary test.
- No raw credentials in requests (schema-level rejection reuses the memory
  credential pattern); no independent state store (replay via
  `projectTaskGraph`); project isolation proven end-to-end.
- Negative gates hold: zero Electron outside `apps/desktop`, zero Prisma
  outside `packages/storage`, SDKs quarantined.

## Non-goals

Full multi-column Workspace, browser automation, MCP Apps UI, plugin
ecosystem, GitHub integration, git automation, background daemon, new planner
or second ReAct loop, new agent-runtime package, Docker logic in
agent-runtime, renderer filesystem access.
