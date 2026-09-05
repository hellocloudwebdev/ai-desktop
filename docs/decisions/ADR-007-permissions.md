# ADR-007: Permissions

- **Status:** Accepted (model locked) — implementation deferred
- **Date:** 2026-09-05

## Context

The agent executes privileged operations: running tools, executing code/containers,
accessing the file system and network. These must be mediated, auditable, and revocable —
skills and tools must not be able to grant themselves authority.

## Decision

A `PermissionManager` inside `permissions` mediates privileged operations:

- **Skills cannot bypass the PermissionManager** (CONSTITUTION.md §3.3). Every privileged
  action a skill requests is checked through it.
- The initial implementation is an allow-all permission manager, standing in until a real
  policy model exists; the mediation seam is the point — policy comes later without
  changing callers.
- `permissions` may depend only on `ai-core`, `storage`, and `shared`
  (dependency-graph.md).

Permission policy design (rules, prompts, user consent UX) is **not specified here** and
will be defined by the permissions implementation PR.

## Consequences

- Privileged operations elsewhere in the system are built against the mediation seam from
  day one, so tightening the policy later requires no caller changes.
- No `PermissionManager` implementation exists in PR1.
