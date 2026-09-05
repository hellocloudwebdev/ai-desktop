# Phase 0 — What Exists and What Does Not

This document prevents the repository (and its documentation) from claiming functionality
that does not exist. It reflects the state after **PR1 (repository foundation)** and is
updated as each PR lands.

## Implemented (as of PR1)

- Repository foundation: pnpm workspace + Turborepo task graph (`build`, `dev`,
  `typecheck`, `lint`, `test`).
- All canonical package boundaries as **empty shells** (`package.json`, `tsconfig.json`,
  `src/index.ts` placeholder, shared ESLint config re-export) — deliberately no
  functionality inside them.
- TypeScript (5.9.3), ESLint (lint-foundation only — architecture/boundary rules arrive in
  PR2), and Prettier configuration.
- Documentation structure: constitution, canonical dependency graph, this document, and
  the ADR series (`docs/decisions/ADR-001` … `ADR-014`).
- CI workflow proving the foundation: install → typecheck → lint → test → build →
  format check.
- `prisma/` as the canonical repository location only (no schema, no dependency).
- `scripts/` directory reserved for repository tooling (empty — nothing speculative).

## Not yet implemented

- `shared` contracts (ULIDs, Result type, IPC contracts, JSON helpers) — PR3.
- `ai-core` (Message, AIEvent, projections, task graph) — PR4/PR5.
- `providers` (no Anthropic or any other provider implementation).
- `storage` (no Prisma schema, no Prisma dependency) — PR8.
- `permissions` (no `PermissionManager`, no allow-all implementation).
- `mcp` (no MCP SDK dependency, no MCP host).
- `skills` (no skill loader).
- `execution` (no Docker/container execution).
- `memory` (no memory storage).
- `agent-runtime` (no `EventBus`, no agent loop).
- `workspace` (no Workspace UI).
- `plugins` (no plugin infrastructure).
- Electron shell (`BrowserWindow`, preload, main process) — PR12.
- Typed IPC — PR13; `ActiveStreamRegistry` — PR14; IPC batching — PR15.
- First end-to-end conversation — PR16.

## Verification

The claims above are checkable:

```sh
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All five succeed against the package shells. A repository search finds no
`@prisma/client`, `@modelcontextprotocol`, `dockerode`, `@anthropic-ai`, Electron
implementations (`BrowserWindow`, `ipcMain`, `ipcRenderer`), or runtime classes
(`EventBus`, `PermissionManager`, `ToolExecutor`, `MCPHost`, `ExecutionManager`,
`MemoryStore`, `AgentLoop`, `AnthropicAdapter`) anywhere in implementation files.
