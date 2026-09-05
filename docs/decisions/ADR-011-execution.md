# ADR-011: Execution

- **Status:** Accepted (principles locked) — implementation deferred
- **Date:** 2026-09-05

## Context

Tool and code execution can be isolated in containers (Docker) or run as host processes.
Execution produces operational records (what ran, when, with what resource usage) that
must be auditable, and it must be the single place where process/container lifecycle is
managed.

## Decision

All execution lives in the `execution` package:

- **`agent-runtime` never calls Docker directly** (CONSTITUTION.md §3.1) — it requests
  execution through `execution`.
- **The `execution` → `storage` edge is intentional**: execution persists session, process,
  and resource-usage metadata through the storage abstractions (dependency-graph.md). It
  never touches the database directly, and the "never import Prisma outside `storage`"
  rule applies.
- `execution` may depend only on `ai-core`, `permissions`, `storage`, and `shared`
  (dependency-graph.md), which is what lets it check executions against the permission
  system.

Whether and how containers are used (Docker vs. alternatives, image policy, limits) is
**not specified here**; the `execution` implementation PR decides that, and PR1 installs
nothing for it.

## Consequences

- No `dockerode` (or similar) dependency may appear before the `execution` implementation
  PR.
- Every execution path funnels through one package, making the audit trail and the
  permission seam (ADR-007) complete.
