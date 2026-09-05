# ADR-013: Tool Lifecycle

- **Status:** Accepted (principles locked) — implementation deferred
- **Date:** 2026-09-05

## Context

Tools produce real side effects: files written, commands run, containers started, network
requests issued. If every tool implements its own execution path, there is no single place
to enforce permissions, timeouts, cancellation, auditing, or event emission.

## Decision

**Every tool uses the same `ToolExecutor` lifecycle** (CONSTITUTION.md §6.1) — one code
path through which all tools run, regardless of origin (built-in, MCP, skill).

**Cancellation is first-class and idempotent** (CONSTITUTION.md §6.2):

- First-class: every long-running operation is cancellable by design, not as an
  afterthought.
- Idempotent: cancelling an already-cancelled or already-finished operation is safe and
  produces no duplicate effects.

The concrete lifecycle stages (validation, permission check, execution, event emission,
cleanup) and the `ToolExecutor` API are **not specified here**; they are designed by the
tool-execution implementation PR. No `ToolExecutor` implementation exists in PR1.

## Consequences

- New tool sources (MCP — ADR-008, skills — ADR-009) plug into the same lifecycle instead
  of inventing parallel ones.
- Every tool run emits events into the authoritative stream (ADR-003), which is what makes
  the audit trail complete.
