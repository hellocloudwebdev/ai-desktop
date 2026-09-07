# Phase 0 — What Exists and What Does Not

This document prevents the repository (and its documentation) from claiming functionality
that does not exist. It reflects the state after **PR15 (IPC event batching)** and
is updated as each PR lands.

## Implemented (as of PR15)

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
- Concrete Anthropic provider adapter (`@ai-desktop/providers`, PR11):
  - `@anthropic-ai/sdk` (0.124.0) encapsulated strictly inside `packages/providers`.
  - Canonical model definitions (`src/anthropic/anthropic-models.ts`): Claude 3.5 Sonnet,
    Claude 3.5 Haiku, Claude 3 Opus with capability ownership.
  - Request translation boundary (`src/anthropic/translate-request.ts`): converts canonical
    `ChatRequest` to native streaming `MessageCreateParams` with multimodal parts, tool definitions,
    thinking budgets, and explicit rejection of unsupported capabilities.
  - Stream translation boundary (`src/anthropic/translate-stream.ts`): converts native chunk
    events to canonical `AIEvent`s (`message.started`, `message.delta`, `tool.call.requested`,
    `message.completed`).
  - Error translation boundary (`src/anthropic/translate-error.ts`): maps native SDK exceptions
    (401 Auth, 429 RateLimit, 400 BadRequest, 500 InternalServer, AbortError) to canonical
    `ProviderError` subclasses without leaking vendor types.
  - `AnthropicAdapter` (`src/anthropic/anthropic-adapter.ts`): implements `ProviderAdapter`,
    cooperative cancellation via standard `AbortSignal`, credential resolution via SecretRef.
  - Opt-in live smoke test (`ANTHROPIC_SMOKE_TEST=1`).
  - 17 unit tests across request translation, stream translation, error translation, and adapter lifecycle.
- Electron desktop application shell (`apps/desktop`, PR12):
  - Electron 44.0.0 main process (`src/main/index.ts`):
    - Creates single `BrowserWindow` with strictly enforced security settings:
      `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
    - Handles standard application lifecycle: `app.whenReady()`, single window activation on macOS,
      `window-all-closed` quit on non-macOS platforms.
    - Dual development/production loading: loads Vite dev server when `VITE_DEV_SERVER_URL` is set;
      loads built local `dist/index.html` in production.
  - Preload bridge (`src/preload/index.ts`):
    - Controlled bridge exposing narrow `window.api` (`DesktopApplicationApi`): platform info and ping.
    - Zero exposure of raw `ipcRenderer`, `ipcMain`, `BrowserWindow`, `shell`, `app`, `process`, or `fs`.
  - React 19.2.8 renderer (`src/renderer/`):
    - `main.tsx` and `App.tsx` styled with Tailwind CSS 4.3.3.
    - Pure browser context: zero Node or Electron imports in renderer code.
    - Strict Content Security Policy configured in `index.html`.
  - Vite 8.1.0 build integration:
    - `vite.config.ts` bundles renderer to `dist/`, and main + preload to `dist-electron/`.
  - 2 unit tests in `apps/desktop/src/__tests__/shell.test.ts` verifying webPreferences security
    and preload bridge isolation.
- Typed Electron IPC boundary (`apps/desktop` & `@ai-desktop/shared`, PR13):
  - Shared typed IPC contract (`packages/shared/src/ipc-contract.ts`): defines canonical channel
    constants (`IPC_CHANNELS`), Zod validation schemas for commands (`ChatSendCommandSchema`,
    `ChatCancelCommandSchema`, `ChatSubscribeCommandSchema`, `ChatUnsubscribeCommandSchema`),
    streaming events (`ChatStreamEventSchema`), and envelopes (`IpcResponseEnvelope`).
  - Main-process IPC dispatch (`apps/desktop/src/main/ipc/`):
    - `IpcRegistry` with `registerCommand`: validates all command input crossing from the renderer
      via Zod schemas in main before handlers execute.
    - Prevents channel collision (throws error if a command channel is registered twice).
    - Structured, safe error responses (returns `{ ok: false, error }` envelopes without leaking
      stack traces, credentials, or file paths).
    - Subscription lifecycle: sends stream events strictly to WebContents, cleans up subscriptions
      automatically upon WebContents destruction.
  - Preload bridge (`apps/desktop/src/preload/index.ts`):
    - Exposes typed `window.api` with `commands` (`checkHealth`, `sendChatMessage`, `cancelChat`)
      and `events` (`subscribeToConversation` returning idempotent `Unsubscribe`).
    - Zero exposure of raw `ipcRenderer`, `ipcMain`, `BrowserWindow`, or Node modules.
  - 5 comprehensive IPC unit tests in `apps/desktop/src/__tests__/ipc.test.ts` verifying
    handler registration, Zod input validation, subscription delivery, WebContents destruction cleanup,
    and idempotent unsubscribe.
- Active streaming cancellation registry (`apps/desktop/src/main/chat/active-stream-registry.ts`, PR14):
  - Registry owning the runtime relationship `MessageId -> AbortController` in the Electron main
    chat-service layer.
  - Invariants enforced:
    - Strictly in-memory runtime state: controllers are NEVER persisted to SQLite, events, or disk.
    - Zero imports of `EventBus`, `@prisma/client`, `storage`, or `providers` in the registry.
    - Cooperative cancellation via standard `AbortController` and `AbortSignal`.
    - Duplicate registration for the same `MessageId` is rejected with `ConflictError`.
    - Idempotent operations: aborting or removing unknown or already-aborted streams is safe and no-op.
    - Stream isolation: aborting one active stream has zero impact on concurrent streams.
    - IPC command integration: wired into `registerIpcHandlers` for `CHAT_CANCEL` command dispatch.
    - Application lifecycle integration: cleared and aborted on application/window teardown.
  - 11 unit and integration tests in `apps/desktop/src/__tests__/active-stream-registry.test.ts`
    verifying registration, rejection of duplicate IDs, abort idempotency, multi-stream isolation,
    async generator cancellation, try/finally cleanup, bulk clear, and typed IPC cancellation dispatch.
- IPC event batcher (`apps/desktop/src/main/ipc/batcher.ts`, PR15):
  - Transport optimization between the internal fine-grained event stream and the renderer:
    canonical `AIEvent`s cross the Electron IPC boundary batched inside a ~32 ms window
    (configurable locally, never exported as a cross-package constant).
  - Terminal events (`message.completed`/`failed`/`cancelled`, `tool.call.completed`/`failed`,
    `execution.completed`/`failed`, `task.completed`/`failed`/`cancelled`) flush immediately,
    carrying all pending conversation events with them in order.
  - Invariants enforced:
    - Transports events untouched: `eventId`, `sequence`, `schemaVersion`, and payloads pass
      through by reference; no merging, sorting, or rewriting (projections own interpretation).
    - One timer per pending conversation batch context; a timer exists only while events are
      pending — no timer-per-event, no global interval.
    - Snapshot-then-clear before send: events enqueued during delivery start the next batch,
      never appended to the in-flight one.
    - Empty flush is a no-op (never sends an empty batch); racing terminal + scheduled flush
      delivers exactly once.
    - WebContents destruction cleans up all its subscriptions, pending batches, and timers.
    - Failed sends never crash the main process; the affected subscription is cleaned up
      without retry loops, dead-letter queues, or persistence.
    - Scoped delivery per the subscription model: events for conversations without subscribers
      are dropped at enqueue time (bounded state; the event storage layer stays authoritative).
  - Integration: `IpcRegistry.attachBatcher` / `publishEvent` as the canonical publication path;
    `CHAT_SUBSCRIBE` / `CHAT_UNSUBSCRIBE` commands wire batcher subscriptions; the preload bridge
    unpacks `chat:stream-batch` envelopes and delivers individual canonical events to the renderer;
    batcher is destroyed with the IPC registry on application teardown.
  - No domain batch event types were added to `ai-core`; the `ChatStreamBatch` envelope is a
    plain transport wrapper living inside apps/desktop.
  - 20 unit and integration tests in `apps/desktop/src/__tests__/ipc-batcher.test.ts` covering
    basic batching, timer boundaries, terminal flush, double flush, empty flush, ordering,
    transport fidelity, renderer isolation, destruction cleanup, send failure, re-entrant events,
    and bounded pending state (Vitest fake timers).
- All remaining canonical packages stay **empty shells** (`package.json`, `tsconfig.json`,
  `src/index.ts` placeholder) — deliberately no premature domain functionality inside them.
- Toolchain: TypeScript 5.9.3, ESLint 10.10.0, Vitest 4.1.10, Vite 8.1.0, Prettier 3.9.6,
  Zod 4.4.3.
- CI workflow: install → typecheck → lint → architecture check → test → build → format check.

## Not yet implemented

- `mcp` (MCP client/server integration) — MCP milestone.
- First end-to-end conversation vertical slice — PR16.

## Verification

The claims above are checkable:

```sh
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All five succeed across the shared, ai-core, agent-runtime (EventBus), permissions, storage, providers, and desktop packages,
while future packages remain shells. A repository search finds no `@modelcontextprotocol`, `dockerode`, or future runtime
classes (`ToolExecutor`, `MCPHost`, `ExecutionManager`, `MemoryStore`, `AgentLoop`) anywhere in implementation files.
`@anthropic-ai/sdk` is strictly isolated within `packages/providers`; `electron` is strictly isolated within `apps/desktop`.
