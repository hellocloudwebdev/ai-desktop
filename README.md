# ai-desktop

A desktop AI assistant. This repository is currently at **PR25 — MCP Foundation**:
shared primitives, canonical AI domain contracts, projections, in-process EventBus,
permission checkpoint, SQLite WAL event repository, OS-backed credential store, canonical
provider contracts, concrete `AnthropicAdapter`, concrete `GeminiAdapter`, Electron 44 desktop
application shell, typed Electron IPC boundary, `ActiveStreamRegistry` main chat cancellation
registry, the ~32 ms IPC event batcher with immediate terminal-event flush, the complete
first vertical conversation slice, comprehensive persistence integration, the formal
Phase 1 Acceptance Gate, runtime `ProviderRegistry`, validated provider configuration,
multi-provider capability integration (Anthropic Claude and Google Gemini 2.5 families),
provider profiles with per-conversation model selection (`ModelSelectionService`),
the definitive provider-neutral `ChatService`, real `PermissionManager` (5-dimension
evaluation, deterministic policy engine, 4 approval scopes, SQLite policy & audit persistence,
batch coalescing, IPC & renderer approval prompt), and the first real MCP integration
(`MCPHost` contract, `InProcessMCPHost`, MCP SDK quarantine, tool discovery, `ToolRegistry`,
`McpToolExecutor` with 256 KB result limit and timeout handling, dynamic `tools/list_changed` sync)
are implemented. Future packages remain empty shells awaiting their respective implementation
PRs — see [docs/architecture/phase-0.md](docs/architecture/phase-0.md) for the honest list of what is
and is not implemented.

## Toolchain

| Tool                      | Version                                  | Notes                                                              |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Node.js                   | >= 22 (developed on 24.16.0)             |                                                                    |
| pnpm                      | 11.25.0                                  | pinned via `packageManager`                                        |
| Turborepo                 | 2.10.12                                  |                                                                    |
| TypeScript                | 5.9.3                                    | TypeScript 7 deliberately not adopted without a compatibility pass |
| Prettier                  | 3.9.6                                    |                                                                    |
| ESLint                    | ^10.10.0 (+ `typescript-eslint` ^8.69.0) |                                                                    |
| eslint-plugin-boundaries  | 7.2.0                                    | AST-level dependency boundaries in per-package lint                |
| Prisma                    | 6.4.1                                    | used strictly inside `@ai-desktop/storage`                         |
| @anthropic-ai/sdk         | 0.124.0                                  | used strictly inside `@ai-desktop/providers`                       |
| @google/genai             | 2.21.0                                   | used strictly inside `@ai-desktop/providers`                       |
| @modelcontextprotocol/sdk | 1.30.0                                   | used strictly inside `@ai-desktop/mcp`                             |
| Vitest                    | 4.1.10                                   | root test runner for repository tooling                            |
| Vite                      | 8.1.0                                    | locked peer foundation for Vitest                                  |
| Electron                  | 44.0.0                                   | desktop shell strictly inside `apps/desktop`                       |
| React                     | 19.2.8                                   | UI renderer strictly inside `apps/desktop`                         |
| Tailwind CSS              | 4.3.3                                    | UI styling via `@tailwindcss/vite` in `apps/desktop`               |

Docker tooling is intentionally **not** a dependency of this repository
yet — it may not be installed before its own implementation PR.

## Quickstart

```sh
pnpm install
pnpm typecheck            # tsc --noEmit in every package
pnpm lint                 # eslint in every package + boundaries enforcement
pnpm architecture:check   # validate declarations, graph edges, and Electron boundary
pnpm test                 # vitest unit tests + package tests via Turbo
pnpm build                # compiles packages and builds desktop shell artifacts
pnpm format               # prettier --write .
pnpm format:check
```

## Packages

All packages are private. `shared` and `ai-core` contain the implemented contract layers;
the rest remain intentionally empty shells. The dependency edges below are the locked
architecture from [docs/architecture/dependency-graph.md](docs/architecture/dependency-graph.md),
mechanically enforced by `scripts/validate-dependencies.mjs` and `eslint-plugin-boundaries`.

| Package                     | Role                                                                                                        | May depend on                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@ai-desktop/shared`        | shared contracts & primitives (implemented in PR3)                                                          | —                                     |
| `@ai-desktop/ai-core`       | messages, content, events, tools, projections (PR4/PR5)                                                     | shared                                |
| `@ai-desktop/providers`     | ProviderAdapter contract, Anthropic (PR11), Gemini (PR21), registry, profiles & model selection (PR19–PR22) | ai-core, shared                       |
| `@ai-desktop/storage`       | persistence (PR8), secrets store (PR9), permission policies & audit (PR24)                                  | ai-core, shared                       |
| `@ai-desktop/permissions`   | PermissionManager mediation, policy evaluator, SQLite policy & audit persistence (PR7, PR24)                | ai-core, storage, shared              |
| `@ai-desktop/mcp`           | MCPHost, InProcessMCPHost, tool discovery, ToolRegistry, McpToolExecutor (PR25)                             | ai-core, storage, permissions, shared |
| `@ai-desktop/skills`        | skill loader                                                                                                | ai-core, storage, shared              |
| `@ai-desktop/execution`     | tool/code/container execution                                                                               | ai-core, permissions, storage, shared |
| `@ai-desktop/memory`        | memory storage                                                                                              | ai-core, storage, providers, shared   |
| `@ai-desktop/agent-runtime` | in-process EventBus (PR6); orchestration (later)                                                            | all of the above                      |
| `@ai-desktop/workspace`     | workspace UI                                                                                                | (later PRs)                           |
| `@ai-desktop/plugins`       | plugin infrastructure                                                                                       | (not yet defined)                     |
| `@ai-desktop/desktop`       | Electron shell, React renderer, typed IPC, multi-provider ChatService, permissions (PR12–PR18, PR22–PR24)   | agent-runtime, shared                 |

## Repository layout

```
apps/desktop/     desktop application shell (Electron main, preload, React renderer)
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
- Runtime dependencies exist only where their PR justified them (`storage`: Prisma +
  `@napi-rs/keyring`; `providers`: `@anthropic-ai/sdk` + `@google/genai`;
  `desktop`: Electron + React). Every dependency added in a future PR must
  be justified by that PR and land in the package that uses it — never at the root "for
  convenience".

## Architecture rules

[CONSTITUTION.md](docs/architecture/CONSTITUTION.md) is normative: no Electron imports
outside `apps/desktop`, no Prisma outside `storage`, SDK types confined to their packages,
events authoritative/immutable/sequenced, secrets never raw in SQLite, one tool lifecycle,
cancellation first-class. ADRs in [docs/decisions/](docs/decisions/) record the decisions
behind those rules; deferred ones say so explicitly instead of inventing detail.
