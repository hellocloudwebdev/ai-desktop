# CONSTITUTION — Architectural Rules

These are normative rules for the `ai-desktop` monorepo. They hold for every PR, without
exception. A rule can only be changed through a new or amended ADR and an explicit review
decision — never silently, and never "temporarily" inside a feature PR.

Import-boundary rules are enforced mechanically by ESLint starting in PR2. Until that
enforcement lands, they are review criteria that every PR is checked against by hand.

## 1. Process and UI boundaries

1.1 **Never import Electron outside `apps/desktop`.** Electron is an application-shell
concern; no package under `packages/` may depend on it.

1.2 **`agent-runtime` remains Electron-agnostic.** It must run in a plain Node.js context.

1.3 **The renderer accesses privileged functionality only through preload IPC.** No direct
Node.js, file-system, or network access from renderer code.

## 2. Package boundaries

2.1 **Never import Prisma outside `storage`.** Prisma (and its generated client) is an
implementation detail of the `storage` package.

2.2 **Provider SDK types remain inside `providers`.** No other package imports
provider SDKs or SDK-derived types.

2.3 **MCP SDK types remain inside `mcp`.** No other package imports the MCP SDK or
SDK-derived types.

## 3. Agent runtime containment

3.1 **`agent-runtime` never calls Docker directly.** All container/process lifecycle goes
through `execution`.

3.2 **`agent-runtime` never calls the MCP SDK directly.** All MCP access goes through
`mcp`.

3.3 **Skills cannot bypass `PermissionManager`.** Every privileged action a skill
requests is mediated by the permission system.

## 4. Events

4.1 **Events are authoritative.** The event stream is the source of truth for what
happened; state is derived from it.

4.2 **Historical events are immutable.** Persisted events are never edited or rewritten.

4.3 **Every persisted event has `sequence` and `schemaVersion`.** No exceptions, so the
stream can be ordered and migrated.

## 5. Secrets

5.1 **Secrets are never stored raw in SQLite.** Secrets are encrypted or held outside the
database before persistence.

## 6. Tools

6.1 **Every tool uses the same `ToolExecutor` lifecycle.** No tool implements its own
execution path.

6.2 **Cancellation is first-class and idempotent.** Any running operation can be
cancelled, and cancelling twice is safe.
