# ADR-005: IPC

- **Status:** Accepted (principles locked) — implementation deferred to PR13–PR15
- **Date:** 2026-09-05

## Context

The Electron renderer is sandboxed (ADR-001) but must reach privileged functionality:
conversations, storage-backed history, permissions, tool activity.

## Decision

The renderer accesses privileged functionality **only through preload IPC** — no direct
Node.js, file-system, or network access from renderer code (CONSTITUTION.md §1.3).

Implementation plan, per the canonical PR sequence:

- **PR13** — typed IPC (channel contracts typed end to end).
- **PR14** — `ActiveStreamRegistry`.
- **PR15** — IPC batching.

Channel naming, serialization, and batching details are specified in those PRs, not here.

## Consequences

- Every renderer→main interaction goes through a typed channel; ad-hoc `ipcRenderer`
  usage outside the preload boundary is a violation.
- Untyped or ad-hoc IPC cannot be introduced earlier as a shortcut.
