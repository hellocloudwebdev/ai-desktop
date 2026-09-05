# ADR-009: Skills

- **Status:** Deferred
- **Date:** 2026-09-05

## Context

The system will support skills — packaged, user- or system-provided capabilities the agent
can exercise. Skills are privileged-adjacent: they can request actions with real side
effects, so the architecture must mediate them.

## Decision

**Deferred.** The skill format, loader, discovery mechanism, and trust model are not
specified in Phase 0 and will be designed by the `skills` implementation PR rather than
invented here.

What is locked now:

- **Skills cannot bypass the PermissionManager** (CONSTITUTION.md §3.3) — whatever the
  loader looks like, every privileged action a skill requests is mediated.
- `skills` may depend only on `ai-core`, `storage`, and `shared` (dependency-graph.md).
- No skill loader implementation exists in PR1.

## Consequences

- Tool and permission abstractions (ADR-007, ADR-013) must be sufficient to host skills
  when they arrive, without special-casing them.
