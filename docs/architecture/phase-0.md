# Phase 0 — What Exists and What Does Not

This document prevents the repository (and its documentation) from claiming functionality
that does not exist. It reflects the state after **PR10 (canonical provider contract)** and
is updated as each PR lands.

## Implemented (as of PR10)

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
- AI core canonical domain contracts & projection layer (`@ai-desktop/ai-core`, PR4 & PR5):
  - Domain IDs (`src/identifiers.ts`): branded `EventId`, `ExecutionId`, and `TaskNodeId`,
    built on shared's canonical ULID primitives.
  - Canonical multimodal content (`src/content.ts`): text, image, audio, video, file,
    tool-call, tool-use, tool-result, code, citation, and thinking parts without provider-native types.
  - Message projection model (`src/message.ts`): materialized `Message` models representing
    projected conversation turns.
  - AI event model (`src/events.ts`): immutable, sequenced, versioned discriminated union
    across Core, Capability, and Extension events. Every persisted event requires
    `eventId`, `conversationId`, `sequence`, `schemaVersion`, and `timestamp`.
  - Tool contracts (`src/tools.ts`): independent `ToolSource` and `ToolRuntime` axes,
    `ToolDefinition`, `ToolCall`, and `ToolResult` contracts.
  - Permission contracts (`src/permissions.ts`): canonical `PermissionRequest` with required
    `relatedToolCallIds` and permission decision models.
  - Execution contracts (`src/execution.ts`): engine-neutral execution requests, limits, and
    outcomes.
  - Task graph contracts (`src/tasks.ts`): durable `Task` and `TaskNode` DAG vocabulary.
  - AI-domain errors (`src/errors.ts`) built from shared's domain-neutral `BaseError`.
  - Pure deterministic projection layer (`src/projections/`):
    - `projectMessages(events)`: replays message events, merges streaming token deltas into
      coherent text blocks, and preserves partial transcripts upon cancellation.
    - `projectConversation(events, conversationId?)`: constructs full conversation view with
      metadata and messages.
    - `projectTaskGraph(events, taskId)`: reconstructs the DAG task graph, validates DAG
      invariants (rejecting self-dependencies, missing dependencies, and cycles), provides
      topological execution order, and handles dynamic replanning (`task.replan`).
  - 47 focused domain and projection unit tests in `packages/ai-core/src/*.test.ts` and
    `packages/ai-core/src/projections/__tests__/*.test.ts`. Full build emits declarations to `dist/`.
- Thin in-process EventBus (`@ai-desktop/agent-runtime`, PR6):
  - In-process event distribution (`src/events/event-bus.ts`): publishes and distributes
    canonical `AIEvent`s to subscribers with strict FIFO publication order preservation.
  - Re-entrancy protection: queues nested publish calls to maintain sequential event dispatch.
  - Subscriber isolation: errors/rejections in individual listeners are isolated and reported
    via configurable `onError` handler without disrupting other listeners.
  - Lifecycle: `subscribe`, `once`, and completely idempotent `unsubscribe` functions.
  - Immutability: published events are frozen to prevent subscriber mutation.
  - Non-responsibilities preserved: zero persistence, zero IPC, zero provider logic,
    and zero agent loop/planning implementation.
  - 14 focused unit tests in `packages/agent-runtime/src/events/__tests__/*.test.ts`; full
    build emits JavaScript and declarations to `dist/`.
- Permission abstraction & Phase-0 permissive manager (`@ai-desktop/permissions`, PR7):
  - Primary interface (`src/core/permission-manager.ts`): `PermissionManager.check(request: PermissionCheck): Promise<PermissionDecisionResult>`.
  - Checkpoint model in `ai-core`: evaluates across the 5 canonical dimensions (`capability`,
    `action`, `resource`, `scope`, `risk`) and requires `relatedToolCallIds` for coalescing.
  - Outcomes: `allow`, `deny`, and `requires_user` with approval modes (`allow_once`,
    `allow_session`, `allow_project`, `deny`).
  - Phase-0 permissive implementation (`src/allow-all/allow-all-permission-manager.ts`):
    strictly validates request schema (rejecting invalid inputs with `ValidationError`),
    unconditionally returns `{ kind: "allow" }` for valid requests, and stores no state.
  - Zero persistence, zero sandboxing, zero interactive UI, zero policy engine.
  - 5 unit tests in `packages/permissions/src/__tests__/*.test.ts`; builds `.js` and declarations to `dist/`.
- Storage persistence foundation (`@ai-desktop/storage`, PR8):
  - Canonical Prisma schema (`prisma/schema.prisma`) targeting SQLite with initial migration.
  - Runtime SQLite WAL mode (`PRAGMA journal_mode = WAL`) activated and actively verified
    via PRAGMA inspection in `src/client/database.ts`.
  - Controlled PrismaClient lifecycle wrapped in `StorageDatabase`.
  - Append-only event persistence (`src/events/prisma-event-repository.ts`):
    - Stores all canonical event fields (`id`, `conversationId`, `taskId`, `sequence`,
      `schemaVersion`, `type`, `payload`, `createdAt`).
    - Enforces uniqueness constraint on `(conversationId, sequence)`: duplicate sequence
      insertion throws structured `DuplicateSequenceError` without overwriting historical records.
    - Reads events strictly sorted in ascending sequence order (`orderBy: { sequence: "asc" }`).
    - Exact JSON payload and schemaVersion round-trip fidelity.
    - Restart recovery: events survive full database close/re-open cycles.
    - Zero update or delete APIs for historical events; historical records remain immutable.
  - 9 focused unit tests in `packages/storage/src/__tests__/*.test.ts`; builds `.js` and declarations to `dist/`.
- Secrets abstraction & OS keychain storage (`@ai-desktop/storage`, PR9):
  - `SecretRef` contract (`src/secrets/secret-ref.ts`): strongly branded, validated reference
    (`app/provider/<id>/api-key`, `ai-desktop/test/<id>`), strictly rejecting whitespace, `=`,
    uppercase characters, or embedded secret values.
  - `SecretStore` interface (`src/secrets/secret-store.ts`): `set`, `get`, `delete`, `has`
    with `SecretBackendError` keeping missing credentials (`null`) and backend failures distinguishable.
  - `OSKeychainSecretStore` (`src/secrets/os-secret-store.ts`): uses native `@napi-rs/keyring`
    (2.0.0, Node 24 + Windows Credential Manager / macOS Keychain / Linux Secret Service).
  - Hard security boundaries enforced:
    - Zero raw secrets in SQLite, events, logs, error messages, or IPC payloads.
    - Zero OAuth/UI logic; provider code never directly imports the native keychain library.
    - Idempotent deletion and safe replacement semantics.
  - 14 focused contract and live platform integration unit tests in `src/__tests__/secrets.test.ts`.
- Canonical provider contract (`@ai-desktop/providers`, PR10):
  - Canonical domain additions in `ai-core` (`src/models.ts` & `src/identifiers.ts`):
    - Branded IDs: `ProviderId`, `ModelId`.
    - Canonical model capabilities: `ModelCapabilitySchema` (`text_generation`, `streaming`,
      `vision`, `audio`, `video`, `tool_use`, `thinking`, `structured_output`).
    - `ModelDefinition`: owns capability declarations, context window, output tokens, pricing.
    - Canonical `ChatRequest`: provider-neutral chat input with `ChatMessageInput` and `ChatRequestOptions`.
  - Canonical adapter interface (`src/core/provider-adapter.ts`):
    - `ProviderAdapter` with `initialize`, `listModels`, `getModel`, `validateConfig`, `supports`,
      and streaming `chat(request, signal): AsyncIterable<AIEvent>`.
    - Invariants enforced: Provider and Model are separate; ModelDefinition owns capabilities;
      cancellation uses standard `AbortSignal`; provider SDK types never escape the adapter boundary;
      OpenAI-compatible APIs are NOT the internal abstraction.
  - Configuration & Errors (`src/core/provider-config.ts` & `src/core/provider-errors.ts`):
    - `ProviderConfig`: references credentials strictly via non-secret `credentialRef` (SecretRef);
      zero raw secrets in provider definitions.
    - `ProviderError`, `ProviderConfigError`, `UnsupportedCapabilityError`, `ModelNotFoundError`,
      `ProviderRequestError` without leaking third-party SDK error types.
  - 9 focused contract tests in `packages/providers/src/__tests__/*.test.ts` verifying
    initialization, config validation, capability detection, streaming, cancellation, and error handling.
- All remaining canonical packages stay **empty shells** (`package.json`, `tsconfig.json`,
  `src/index.ts` placeholder) — deliberately no premature domain functionality inside them.
- Toolchain: TypeScript 5.9.3, ESLint 10.10.0, Vitest 4.1.10, Vite 8.1.0, Prettier 3.9.6,
  Zod 4.4.3.
- CI workflow: install → typecheck → lint → architecture check → test → build → format check.

## Not yet implemented

- `providers` (Anthropic concrete adapter) — PR11.
- `mcp` (MCP client/server integration) — PR11/PR12.
- Electron shell (`BrowserWindow`, preload, main process) — PR12.
- Typed IPC — PR13; `ActiveStreamRegistry` — PR14; IPC batching — PR15.
- First end-to-end conversation — PR16.

## Verification

The claims above are checkable:

```sh
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All five succeed across the shared, ai-core, agent-runtime (EventBus), permissions, storage, and providers packages,
while future packages remain shells. A repository search finds no `@anthropic-ai/sdk`,
`@modelcontextprotocol`, `dockerode`, Electron implementations (`BrowserWindow`, `ipcMain`, `ipcRenderer`),
or future runtime classes (`ToolExecutor`, `MCPHost`, `ExecutionManager`, `MemoryStore`,
`AgentLoop`, `AnthropicAdapter`) anywhere in implementation files.
