# ADR-003: Event Core

- **Status:** Accepted (principles locked) — implementation deferred to PR4/PR5
- **Date:** 2026-09-05

## Context

Conversations, tool runs, permissions, and system activity must be observable, auditable,
and recoverable. Scattering this state across ad-hoc flags and caches makes replay,
debugging, and UI consistency impossible.

## Decision

The event stream is the backbone of the system, with three constitutional principles:

1. **Events are authoritative** — the stream is the source of truth for what happened;
   state is derived from it.
2. **Historical events are immutable** — persisted events are never edited or rewritten.
3. **Every persisted event carries `sequence` and `schemaVersion`** — so the stream can be
   ordered deterministically and migrated across schema changes.

Detailed event schemas (`AIEvent`, message events), the projection layer, and the task
graph are designed and implemented in PR4/PR5 — they are intentionally **not** specified
here to avoid inventing details before that design work.

## Consequences

- Storage (ADR-006) must persist events with their sequence and schema version and treat
  them as append-only.
- Every future feature models its state changes as events first.
