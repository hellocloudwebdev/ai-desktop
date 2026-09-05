# ai-desktop

A desktop AI assistant. This repository is currently at **PR1 — repository foundation**:
a valid pnpm/Turborepo monorepo with all canonical package boundaries established as
empty shells. No application functionality exists yet — see
[docs/architecture/phase-0.md](docs/architecture/phase-0.md) for the honest list of what
is and is not implemented.

## Toolchain

| Tool       | Version                                  | Notes                                                              |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Node.js    | >= 22 (developed on 24.16.0)             |                                                                    |
| pnpm       | 11.25.0                                  | pinned via `packageManager`                                        |
| Turborepo  | 2.10.12                                  |                                                                    |
| TypeScript | 5.9.3                                    | TypeScript 7 deliberately not adopted without a compatibility pass |
| Prettier   | 3.9.6                                    |                                                                    |
| ESLint     | ^10.10.0 (+ `typescript-eslint` ^8.69.0) | lint foundation only; boundary rules arrive in PR2                 |

Electron is **not** a dependency of this repository yet (locked architecturally, pinned in
PR12). The same applies to Prisma, the MCP SDK, provider SDKs, and Docker tooling — none
of them may be installed before their own implementation PR.

## Quickstart

```sh
pnpm install
pnpm typecheck   # tsc --noEmit in every package
pnpm lint        # eslint in every package
pnpm test        # placeholder until packages gain tests
pnpm build       # placeholder until packages gain build outputs
pnpm format      # prettier --write .
pnpm format:check
```

## Packages

All packages are private shells at this stage. The dependency edges below are the locked
architecture from [docs/architecture/dependency-graph.md](docs/architecture/dependency-graph.md);
PR2 enforces them mechanically.

| Package                     | Role                                                | May depend on                         |
| --------------------------- | --------------------------------------------------- | ------------------------------------- |
| `@ai-desktop/shared`        | shared contracts (PR3)                              | —                                     |
| `@ai-desktop/ai-core`       | messages, events, projections, task graph (PR4/PR5) | shared                                |
| `@ai-desktop/providers`     | model providers; SDK types stay here                | ai-core, shared                       |
| `@ai-desktop/storage`       | persistence; the only Prisma consumer (PR8)         | ai-core, shared                       |
| `@ai-desktop/permissions`   | PermissionManager mediation                         | ai-core, storage, shared              |
| `@ai-desktop/mcp`           | MCP host; SDK types stay here                       | ai-core, storage, permissions, shared |
| `@ai-desktop/skills`        | skill loader                                        | ai-core, storage, shared              |
| `@ai-desktop/execution`     | tool/code/container execution                       | ai-core, permissions, storage, shared |
| `@ai-desktop/memory`        | memory storage                                      | ai-core, storage, providers, shared   |
| `@ai-desktop/agent-runtime` | Electron-agnostic orchestration                     | all of the above                      |
| `@ai-desktop/workspace`     | workspace UI                                        | (later PRs)                           |
| `@ai-desktop/plugins`       | plugin infrastructure                               | (not yet defined)                     |
| `@ai-desktop/desktop`       | Electron shell app (PR12)                           | agent-runtime                         |

## Repository layout

```
apps/desktop/     desktop application shell (Electron arrives in PR12)
packages/         the twelve domain packages above
prisma/           canonical location for the Prisma schema (schema arrives in PR8)
docs/architecture/  CONSTITUTION.md, dependency-graph.md, phase-0.md
docs/decisions/     ADR-001 … ADR-014
scripts/          reserved for repository tooling (intentionally empty)
.github/          CI proving the foundation
```

## Dependency policy

- Root `package.json` owns repo-wide tools: `turbo`, `prettier`, `typescript`
  (for `pnpm exec tsc` at the root), and the lint stack (`eslint`, `typescript-eslint`),
  because the shared `eslint.config.mjs` lives at the root and resolves its plugin from
  there.
- Each package owns the tools its own scripts execute: `typescript`, `eslint`,
  `typescript-eslint`.
- No runtime dependencies exist anywhere yet. Every dependency added in a future PR must
  be justified by that PR and land in the package that uses it — never at the root "for
  convenience".

## Architecture rules

[CONSTITUTION.md](docs/architecture/CONSTITUTION.md) is normative: no Electron imports
outside `apps/desktop`, no Prisma outside `storage`, SDK types confined to their packages,
events authoritative/immutable/sequenced, secrets never raw in SQLite, one tool lifecycle,
cancellation first-class. ADRs in [docs/decisions/](docs/decisions/) record the decisions
behind those rules; deferred ones say so explicitly instead of inventing detail.
