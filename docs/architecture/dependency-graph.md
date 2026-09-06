# Canonical Package Dependency Graph

This is the locked architecture. PR1 establishes the structure; **PR2 enforces these edges
mechanically** (ESLint import rules / package dependency validation). Until then, this
document is the reference a reviewer checks against.

## Overview

```
                    shared
                       │
                    ai-core
                       │
        ┌──────────────┼──────────────┐
   providers        storage      permissions
        │              │              │
        │              ├──────────────┤
        │            skills ──────────┤
        │              │              │
        │           execution ────────┤
        │              │              │
        │            memory           │
        │              │              │
        └──────────────┴──────┬───────┘
                          mcp ────────── (depends on ai-core, storage,
                                           permissions, shared)
                              │
                       agent-runtime
                              │
                           desktop
```

## Allowed dependencies (exhaustive)

A package may only depend on the packages listed below (plus itself). Anything not listed
is forbidden.

| Package         | May depend on                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `shared`        | —                                                                                                                         |
| `ai-core`       | `shared`                                                                                                                  |
| `providers`     | `ai-core`, `shared`                                                                                                       |
| `storage`       | `ai-core`, `shared`                                                                                                       |
| `permissions`   | `ai-core`, `storage`, `shared`                                                                                            |
| `mcp`           | `ai-core`, `storage`, `permissions`, `shared`                                                                             |
| `skills`        | `ai-core`, `storage`, `shared`                                                                                            |
| `execution`     | `ai-core`, `permissions`, `storage`, `shared`                                                                             |
| `memory`        | `ai-core`, `storage`, `providers`, `shared`                                                                               |
| `agent-runtime` | `ai-core`, `providers`, `permissions`, `mcp`, `skills`, `execution`, `memory`, `storage`, `shared`                        |
| `workspace`     | not yet defined — edges are added in later PRs as workspace UI dependencies are locked                                    |
| `desktop`       | `agent-runtime` (and, transitively, everything above)                                                                     |
| `plugins`       | not yet defined — the plugin architecture is a later decision; no dependency edges are locked for this package in Phase 0 |

## Deliberate, non-obvious edges

### `execution` → `storage` (intentional)

`execution` may persist session, process, and resource-usage metadata through the storage
abstractions. This edge is deliberate: execution produces auditable operational records
(what ran, under which permission, with what resource usage), and those records belong in
storage like any other persisted state. It does **not** mean execution touches the database
directly — it goes through `storage`'s interfaces, and the constitutional rule
"never import Prisma outside storage" still applies.

### `agent-runtime` is a pure composition layer

`agent-runtime` sits on top of every domain package and is allowed to depend on all of
them, but it remains Electron-agnostic (see CONSTITUTION.md §1.2) and never reaches around
the packages it composes: it does not call Docker directly (execution does) and does not
call the MCP SDK directly (mcp does).

## Enforcement status

- **PR1:** structure exists; edges documented here.
- **PR2 (current state):** mechanical enforcement is fully active:
  1. **Machine-readable graph:** `docs/architecture/dependency-graph.json` is the single source of truth for allowed edges and package locations.
  2. **ESLint boundary rules:** `eslint-plugin-boundaries` (7.2.0) is configured per-package via `scripts/eslint-package-config.mjs` to enforce allowed edges at AST level during `pnpm lint`.
  3. **Dependency validator:** `scripts/validate-dependencies.mjs` (`pnpm architecture:check`) checks the workspace in one pass: validates package.json declarations against graph edges, prevents undeclared imports, prevents relative package escapes, enforces the `workspace:` protocol, and enforces the Electron boundary.
  4. **Test suite:** `scripts/validate-dependencies.test.mjs` tests the validator itself across valid and invalid edge scenarios.
  5. **CI gate:** `.github/workflows/ci.yml` runs `pnpm lint` and `pnpm architecture:check` on every push and pull request. Failure blocks merge.
