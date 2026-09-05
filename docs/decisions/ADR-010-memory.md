# ADR-010: Memory

- **Status:** Deferred
- **Date:** 2026-09-05

## Context

The agent needs memory beyond a single conversation: durable facts, preferences, and
session context that persist across conversations and inform future behavior. Memory
content is sensitive and must go through the same persistence and security rules as
everything else.

## Decision

**Deferred.** The memory model — what is stored, how it is structured, retrieved, and
expired — is not specified in Phase 0 and will be designed by the `memory` implementation
PR rather than invented here.

What is locked now:

- `memory` is its own package, may depend only on `ai-core`, `storage`, `providers`, and
  `shared` (dependency-graph.md), and persists through `storage` abstractions — never the
  database directly.
- Secrets are never stored raw (CONSTITUTION.md §5.1); memory content does not get an
  exemption.
- No memory storage implementation exists in PR1.

## Consequences

- `agent-runtime` consumes memory through the `memory` package's interface when it lands,
  which keeps the runtime's composition role clean (ADR-012).
