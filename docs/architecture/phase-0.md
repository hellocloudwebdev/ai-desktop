# Phase 0 — What Exists and What Does Not

This document prevents the repository (and its documentation) from claiming functionality
that does not exist. It reflects the state after **PR3 (shared contracts)** and is
updated as each PR lands.

## Implemented (as of PR3)

- Repository foundation: pnpm workspace + Turborepo task graph (`build`, `dev`,
  `typecheck`, `lint`, `test`).
- Mechanical architectural enforcement (PR2):
  - Machine-readable locked dependency graph: `docs/architecture/dependency-graph.json`.
  - ESLint boundary rules: `eslint-plugin-boundaries` (7.2.0) integrated across all 13
    workspace packages via `scripts/eslint-package-config.mjs`.
  - Dependency validator: `scripts/validate-dependencies.mjs` (`pnpm architecture:check`).
  - Validator test suite: `scripts/validate-dependencies.test.mjs` (19 Vitest tests).
- Shared contracts & primitives package (`@ai-desktop/shared`, PR3):
  - Logical Entity IDs (`src/ids.ts`): strongly typed branded ULIDs (`ConversationId`,
    `MessageId`, `TaskId`, `ToolCallId`, `PermissionRequestId`), Crockford Base32 generator
    (zero-dependency via `globalThis.crypto`), timestamp extraction, and parsers.
  - Result primitive (`src/result.ts`): generic domain-neutral `Result<T, E>` with functional
    combinators (`map`, `mapErr`, `flatMap`, `unwrap`, `unwrapOr`, `match`, `fromThrowable`,
    `fromPromise`, `all`).
  - Error primitives (`src/errors.ts`): domain-neutral `BaseError` and typed subclasses
    (`ValidationError`, `NotFoundError`, `InvalidArgumentError`, `TimeoutError`,
    `CancelledError`, `ConflictError`, `InternalError`), formatters, and error coercion.
  - Time primitives (`src/time.ts`): branded ISO-8601 UTC `Timestamp` representation,
    validation, creation, epoch/Date conversions, and chronological comparison.
  - IPC contract specification (`src/ipc-contract.ts`): Electron-independent channel names,
    Zod runtime validation schemas for commands (`ChatSendCommand`, `ChatCancelCommand`,
    `ChatSubscribeCommand`), stream events (`ChatStreamEvent`), and generic envelopes.
  - 47 unit tests in `packages/shared/src/*.test.ts` verifying all primitives.
  - Full TypeScript build output (`dist/`) with declarations and source maps.
- All other canonical packages remain **empty shells** (`package.json`, `tsconfig.json`,
  `src/index.ts` placeholder) — deliberately no premature domain functionality inside them.
- Toolchain: TypeScript 5.9.3, ESLint 10.10.0, Vitest 4.1.10, Vite 8.1.0, Prettier 3.9.6,
  Zod 4.4.3.
- CI workflow: install → typecheck → lint → architecture check → test → build → format check.

## Not yet implemented

- `ai-core` (Message, AIEvent, projections, task graph) — PR4/PR5.
- `EventBus` — PR6.
- `permissions` (`AllowAllPermissionManager`) — PR7.
- `storage` (Prisma schema, Prisma client, migrations) — PR8.
- `providers` (Anthropic adapter, capability models) — PR9.
- `mcp` (MCP client/server integration) — PR10/PR11.
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
