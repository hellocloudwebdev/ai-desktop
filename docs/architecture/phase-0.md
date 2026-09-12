# Phase 0 — What Exists and What Does Not

This document prevents the repository (and its documentation) from claiming functionality
that does not exist. It reflects the state after **PR28 (Memory Subsystem)** and
is updated as each PR lands.

## Implemented (as of PR28)

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
- First end-to-end conversation vertical slice (`apps/desktop`, PR16):
  - Proven complete end-to-end pipe:
    React UI → window.api → typed Electron IPC → Main Chat Service → ActiveStreamRegistry → AnthropicAdapter → canonical AIEvents → EventBus (storage + IPC Batcher) → preload / window.api → React Renderer.
  - Main `ChatService` (`apps/desktop/src/main/chat/chat-service.ts`):
    - Reconstructs authoritative conversation context from persisted events (`projectConversation`).
    - Validates requested `ModelId` against provider catalog (`ModelNotFoundError`).
    - Emits and persists canonical user message event (`message.created`).
    - Registers stream in `ActiveStreamRegistry` before calling provider; passes `AbortSignal` for cooperative cancellation.
    - Streams assistant response, publishes canonical events (`message.started`, `message.delta`, `message.completed`, `message.cancelled`, `message.failed`) through `EventBus` and `EventRepository`.
    - Enforces strict sequence monotonicity (`sequence: 0, 1, 2, ...`) without duplicate positions.
    - Guaranteed stream cleanup (`registry.remove`) in `finally`.
    - Distinguishes cancellation from ordinary provider failure.
    - Guarantees exactly one terminal lifecycle event per stream (no duplicate completion/cancellation).
  - Storage & SQLite WAL recovery:
    - Every event is durably committed to SQLite in WAL mode (`PRAGMA journal_mode = wal`).
    - Application restart recovery: conversation reconstructed from persisted events via `getConversation` / `projectConversation`.
  - Typed IPC & Preload bridge:
    - `CHAT_SEND` (`chat:send`) with Zod validation rejecting malformed input before ChatService runs.
    - `CHAT_CANCEL` (`chat:cancel`) triggering real provider request abort via `ActiveStreamRegistry`. Idempotent.
    - `CONVERSATION_LOAD` (`conversation:load`) loading persisted conversations for restart recovery.
  - React Streaming UI (`apps/desktop/src/renderer/App.tsx`):
    - Message list displaying user, streaming assistant, completed, cancelled, and failed messages.
    - Incremental streaming projection: updates text on token deltas without waiting for complete.
    - Cancellation button active during streaming; partial transcript preserved upon cancel.
    - Input and send button with double-submission prevention.
  - 49 unit and integration tests in `apps/desktop` covering ChatService, stream lifecycle, cancellation, partial transcript preservation, SQLite WAL restart recovery, IPC malformed input rejection, and EventBus -> IPC Batcher -> WebContents delivery.
- Persistence integration & SQLite WAL durability (`apps/desktop` & `@ai-desktop/storage`, PR17):
  - Explicit storage consumer on EventBus (`attachStorageConsumer`):
    - Subscribes `EventRepository` to `EventBus`, automatically persisting all published canonical `AIEvent`s.
    - Handles producer persistence-before-delivery deduplication gracefully (`DuplicateSequenceError`).
  - Strict sequence monotonicity & continuity:
    - Sequence allocator ensures strictly ordered sequences `0, 1, 2, ...` per conversation.
    - Application restart reads highest existing sequence from SQLite and continues monotonically at `max(sequence) + 1`, preventing sequence collisions.
    - Database constraint `UNIQUE(conversationId, sequence)` rejects accidental duplicate sequence writes while permitting identical sequences across independent conversations.
  - Lifecycle durability & failure handling:
    - Canonical events persisted throughout stream lifecycle (started, deltas, terminal events) into SQLite in WAL mode (`PRAGMA journal_mode = wal`).
    - Storage faults are observable and deterministic: storage failures reject user commands immediately or emit `message.failed` without pretending state was persisted.
    - Safe teardown: database connections closed cleanly on application exit through the storage abstraction.
  - Restart recovery & projection equivalence:
    - Replay of persisted events through `projectConversation` perfectly reconstructs multi-turn conversations, including partial transcripts from cancelled streams.
    - Live streaming incremental projection and bulk replay projection verified structurally equivalent.
  - 10 comprehensive persistence integration tests in `apps/desktop/src/__tests__/persistence-integration.test.ts` verifying full stream persistence, cancellation replay, failure recovery, ordered reads, constraint rejection, cross-conversation isolation, schemaVersion/payload round-trip, restart recovery, storage failure handling, and EventBus storage consumer integration.
- Phase 1 acceptance gate (`docs/architecture/phase-1-acceptance.md` & `apps/desktop`, PR18):
  - Formal verification proving that the foundations implemented across PR1–PR17 satisfy all
    12 canonical Phase-1 acceptance requirements.
  - 11 dedicated acceptance tests in `apps/desktop/src/__tests__/phase-1-acceptance.test.ts`
    verifying streaming, real provider abort, prompt cancellation delivery, partial transcript
    survival, restart recovery, cancellation idempotency, malformed IPC rejection in main,
    sequence monotonicity, replay determinism, active SQLite WAL mode, and permission checkpoint.
  - Complete auditable gate report documented in `docs/architecture/phase-1-acceptance.md`.
  - Confirms Phase 1 is complete and verified with zero architectural shortcuts.
- Provider registry & model catalog foundation (`packages/providers/src/registry/`, PR19):
  - `ProviderRegistry`: runtime discovery and registration mechanism for multiple providers and models.
  - Strict Provider vs. Model separation: `ProviderRegistration` registers the provider identity and its `ProviderAdapter`; `ModelRegistration` registers the `ModelDefinition`.
  - ModelDefinition owns capabilities: capabilities (`text_generation`, `streaming`, `vision`, `tool_use`, etc.) belong exclusively to the model definition, not the provider.
  - Registration invariants enforced:
    - Duplicate provider ID registration rejected with descriptive Error.
    - Duplicate model ID registration rejected with descriptive Error.
    - Registering a model whose owning provider is not yet registered is strictly rejected.
    - Unknown provider or model lookups return `undefined`.
    - Pure in-memory runtime discovery: `listProviders()`, `listModels()`, `listModelsForProvider(providerId)`, `hasProvider()`, `hasModel()`.
  - 10 unit tests in `packages/providers/src/registry/provider-registry.test.ts` verifying all registry invariants.
- Provider configuration & validation (`packages/providers/src/core/provider-config-validator.ts`, PR20):
  - `ProviderConfigSchema`: structural validation rejecting empty credential references and strictly forbidding raw credentials (`apiKey`, `accessToken`, `refreshToken`, `password`, `secret`).
  - `DefaultProviderConfigValidator` / `validateProviderConfig`:
    - Orchestrates structural validation, converting raw Zod errors into canonical `ProviderConfigError` instances.
    - Enforces provider ID consistency (`config.providerId === adapter.providerId`).
    - Delegates semantic, provider-owned validation to `adapter.validateConfig(config)`.
    - Pure synchronous/offline execution: zero network calls.
  - Strengthened `AnthropicAdapter.validateConfig`:
    - Verifies `endpointUrl` protocol (`http:` / `https:`).
    - Checks `credentialRef` does not contain raw API keys.
    - Checks `defaultModelId` against supported Anthropic model definitions.
    - Checks `timeoutMs` is a positive, finite integer.
  - `ProviderRegistry.validateConfig(config)`: resolves registered adapter and delegates validation cleanly.
  - 11 unit tests in `packages/providers/src/core/provider-config-validator.test.ts`.
- Concrete Google Gemini provider adapter (`packages/providers/src/gemini/`, PR21):
  - Second native provider implementation conforming to the canonical `ProviderAdapter` interface without relying on OpenAI-compatibility shims.
  - `@google/genai` (2.21.0) strictly encapsulated within `packages/providers`.
  - Canonical Gemini 2.5 model catalog (`gemini-models.ts`): Gemini 2.5 Flash, Gemini 2.5 Flash-Lite (conservative capability mapping: no thinking), and Gemini 2.5 Pro (1M/2M token context limits).
  - Request translation boundary (`translate-request.ts`): converts canonical `ChatRequest` to native `GenerateContentParameters`, translating namespaced `gemini:gemini-2.5-flash` to native `gemini-2.5-flash`, mapping roles (`user`, `model`, `systemInstruction`), multimodal inline parts, tool definitions (`FunctionDeclaration`), thinking configuration, and structured JSON output.
  - Streaming translation boundary (`translate-stream.ts`): converts native `GenerateContentResponse` async generator into canonical `AIEvents` (`message.started`, `message.delta`, `thinking.delta`, `thinking.completed`, `tool.call.requested`, `message.completed`), with usage mapping and Google finish reason translation.
  - Error translation boundary (`translate-error.ts`): converts native `@google/genai` exceptions (`400`, `401`, `403`, `404`, `429`, `5xx`, connection/timeout) into canonical `ProviderError` subclasses (`ProviderRequestError`, `ModelNotFoundError`, `ProviderError("CANCELLED")`), sanitizing credentials and headers.
  - `GeminiAdapter` (`gemini-adapter.ts`): implements `ProviderAdapter`, lifecycle `initialize`, `listModels`, `getModel`, `validateConfig`, `supports`, and streaming `chat(request, signal)` with cooperative `AbortSignal` cancellation forwarded to native request configuration.
  - Multi-provider registration in `ProviderRegistry`: registers both Anthropic and Gemini adapters and all 6 models concurrently.
  - 47 unit and integration tests across Gemini models, request translation, streaming translation, error translation, adapter lifecycle, and multi-provider registry integration.
- Model & profile selection foundation (`packages/providers` & `packages/storage`, PR22):
  - Canonical contracts: `ProviderProfile` (user instance storing only non-secret `credentialRef`, never raw keys) and `ModelSelection` (`providerId` + `modelId`).
  - Validation: `validateProviderProfile` (verifies non-empty name, provider registration, model capability baseline, rejects raw API keys) and `validateModelSelection` (verifies provider exists, model exists, model providerId matches selection).
  - Storage repositories: `provider_profiles` and `conversation_models` tables in SQLite schema with epoch-millisecond `BigInt` columns, `PrismaProviderProfileRepository` (full CRUD), and `PrismaConversationModelRepository` (upsert/get/delete).
  - Renderer model selector dropdown with per-conversation model persistence.
  - 47 unit and integration tests covering profiles, conversation models, and restart recovery.
- Definitive multi-provider Chat Service (`apps/desktop`, PR23):
  - Completely provider-neutral `ChatService` (`apps/desktop/src/main/chat/chat-service.ts`):
    - Zero vendor SDK imports (`@anthropic-ai/sdk`, `@google/genai`), zero vendor request/response structures.
    - Legacy single-provider production path fully removed: execution routes strictly through `ModelSelectionService`.
    - Bundles resolution into an explicit, typed `ChatExecutionContext` (`conversationId`, `modelSelection`, `model`, `adapter`, `request`).
    - Capability pre-check via `validateRequestCapabilities`: rejects unsupported capabilities (e.g., thinking on Gemini Flash-Lite) with call count = 0 before network execution.
    - Dynamic multi-provider routing through `ProviderRegistry` to `AnthropicAdapter` or `GeminiAdapter`.
    - Concurrent multi-provider execution: independent streams to Anthropic and Gemini operate in parallel without cross-routing.
    - Strict cross-conversation isolation: events and sequences remain strictly conversation-scoped.
    - Sibling stream cancellation: cancelling stream in Conversation A leaves concurrent stream in Conversation B unaffected.
    - Idempotent cancellation: safe to call repeatedly, on completed streams, or on unknown message IDs without duplicate events.
    - Terminal-state invariant: exactly one terminal state per execution (`message.completed`, `message.cancelled`, or `message.failed`).
    - Error propagation: provider errors mapped cleanly without automatic, silent provider fallback.
    - Restart recovery for both providers: conversation history and model choices reconstruct faithfully from SQLite WAL.
  - 17 dedicated multi-provider integration tests in `apps/desktop/src/__tests__/multi-provider-chat-service.test.ts`; 101 tests in desktop, 383 tests passing monorepo-wide.
- Real permissions foundation (`packages/permissions`, `packages/storage`, and `apps/desktop`, PR24):
  - Replaced Phase 0/1 `AllowAllPermissionManager` with production `DefaultPermissionManager` connected to storage and `EventBus`.
  - Evaluates all 5 canonical dimensions (`capability`, `action`, `resource`, `scope`, `risk`) using pure deterministic `PermissionPolicyEvaluator` with explicit deny precedence.
  - 4 canonical approval modes: `allow_once` (authorizes specific `relatedToolCallIds`), `allow_session` (in-memory, vanishes on app restart), `allow_project` (persisted in SQLite `permission_policies` table scoped strictly to `projectId`), and `deny`.
  - Append-only immutable `permission_audit` table in SQLite WAL recording capability, action, resource, scope, risk, decision, and tool call IDs with zero secrets or raw credentials.
  - Canonical event emission: `permission.requested`, `permission.granted`, `permission.denied`, `permission.revoked`, `permission.policy.changed`.
  - Batch coalescing: same batch + same capability + same scope + same resource coalesces into a single `PermissionRequest` with all `relatedToolCallIds`.
  - Security dimensions: filesystem path-aware (no directory boundary escapes), execution command/cwd-aware (word boundary matching), MCP per-tool, and strict separation between `secrets.use` and `secrets.read` (the former never grants the latter).
  - Revocation: `revoke()` clears session and project policies and emits `permission.revoked`, ensuring subsequent checks return `requires_user` without rewriting audit history.
  - Typed IPC: `permission:check`, `permission:requests-list`, `permission:resolve`, `permission:revoke`, `permission:policies-list`.
  - Renderer approval UI with 4 distinct choices: Allow once, Allow for session, Allow for project, Deny.
  - 26 tests in permissions, 46 in storage, 106 in desktop, 418 total in workspace.
- MCP foundation & tool discovery (`packages/mcp`, PR25):
  - `MCPHost` application boundary contract and `InProcessMCPHost` implementation managing official `@modelcontextprotocol/sdk` (1.30.0) Client and Transport sessions.
  - Complete MCP SDK quarantine: `@modelcontextprotocol/sdk` installed and used strictly within `packages/mcp`; zero SDK types escape to Agent Runtime or other packages.
  - Verified MCP v2 package split: supports `stdio`, `sse`, and `in_memory` transports (for fast, hermetic testing).
  - `McpServerConfigSchema`: validates configuration at runtime and strictly rejects raw credentials (`apiKey`, `password`, `secret`, `accessToken`, `authorization`).
  - Canonical tool discovery: converts raw MCP tools into canonical `ToolDefinition` with `source = "mcp"`, `runtime = "mcp_protocol"`, locked stable tool ID `mcp:<serverId>/<toolName>`, and deterministic SHA-256 definition hash.
  - `ToolRegistry`: manages discovered tools, detects definition hash changes, and invalidates affected trust grants.
  - Dynamic `tools/list_changed` notification handling: listens for MCP server notifications and resyncs definitions without requiring client restarts.
  - `McpToolExecutor`: enforces the universal tool lifecycle (`validation -> permission -> execution`). Input validation failure aborts before `PermissionManager.check()`; permission denial halts execution before the MCP backend is invoked.
  - Enforces tool timeouts (soft warning + hard timeout terminating operation via `AbortSignal`) and the global 256 KB result ceiling.
  - Multi-server namespace isolation and idempotent connect/disconnect lifecycle.
  - 26 unit and integration tests across server configuration, converter, tool registry, in-process host, and security lifecycle; 444 total tests passing workspace-wide.
- Skills foundation (`packages/skills`, PR26):
  - Skill package architecture (`Skill ≠ Agent`): packages instructions, references, assets, and executable scripts without owning an autonomous agent loop.
  - Reuses canonical `SkillId` from `ai-core`.
  - Enforced lifecycle states: `Installed -> Enabled -> Active`. Inactive skills have zero tools registered in `ToolRegistry`.
  - Manifest validation (`SkillManifestSchema`) enforcing SemVer, capability declarations, and strict relative path safety (forbidding path traversal `..` and absolute paths).
  - Pre-execution checksum verification: SHA-256 script checksum verified immediately before execution; tampered scripts on disk are blocked immediately.
  - On-demand reference content loading with path containment and 512 KB per-file ceiling.
  - 17 unit and integration tests in `packages/skills`.
- Sandboxed execution engine (`packages/execution`, PR27):
  - Canonical separation of `Session` (workspace, mounts, environment state) from `Execution` (single command/process invocation).
  - `DefaultExecutionManager`: orchestrates `validation -> permission -> session -> sandboxProvider.execute()`. Zero Docker-specific code in `ExecutionManager`.
  - `SandboxProvider` contract and `DockerProvider` / `LocalProcessSandboxProvider` implementations.
  - `DockerProvider`: enforces non-root container execution (`--user 1000:1000`), explicit workspace mounting (read-only by default, forbids root, `/etc`, `$HOME`, docker socket), restricted networking by default (`--network none`), actual resource enforcement (CPU `--cpus`, memory `--memory`, PID `--pids-limit=100`), hard wall-clock timeout terminating underlying container, and orphan container cleanup.
  - `LocalProcessSandboxProvider`: process containment with environment allowlisting (never wholesale `process.env`), hard wall-clock timeouts, cooperative `AbortSignal` cancellation, and global 256 KB result ceiling.
  - Skill script execution integration: Skill scripts execute exclusively through `ExecutionManager` and `SandboxProvider` with pre-execution checksum verification.
  - 18 unit and integration tests in `packages/execution`; 479 total tests passing workspace-wide.
- Scoped import_guard subsystem (`packages/ai-core`, `packages/memory`, `packages/storage`, `apps/desktop`, PR28):
  - Canonical `MemoryFact` contract in `ai-core` (`memory.ts`): `id`, `scopeLevel` (`global` | `project`), `projectId` (required for project, absent for global), `content` (max 2000 chars), `category` (`preference` | `fact` | `instruction` | `project_context` | `workflow`), `sensitivity` (`normal` | `sensitive`), `sourceConversationId`, `confidence` (0.0–1.0), timestamps, and `supersededBy` reference. Raw credentials (API keys, tokens, private keys, passwords) rejected at schema level.
  - `MemoryFactId` branded ULID added to `shared`/`ai-core` identifiers alongside existing ID vocabulary.
  - `MemoryService` in `packages/memory`: CRUD over `MemoryRepository`, contradiction handling via `supersedeFact` (superseded facts kept for history, excluded from default retrieval), bounded import_guard context builder (`maxFacts`, `maxCharacters`) with scope attribution, sensitivity filtering (sensitive facts excluded from automatic injection), deterministic relevance retrieval (scope → term overlap → confidence → recency), injection disable toggle (facts remain stored, nothing injected), and project deletion cleanup (project facts removed, global memory survives).
  - `MemoryRepository` abstraction in `packages/storage` backed by SQLite WAL `memory_facts` table (`PrismaMemoryRepository`); Prisma remains confined to storage. Indexed on `scopeLevel`, `projectId`, `updatedAt`, `supersededBy`.
  - Incremental extractor (`extractFactsFromMessage`): operates on canonical message text only (never provider SDK data); classifies explicit user statements with high confidence (preference 0.95, instruction 0.9, project_context 0.85, workflow 0.8, fallback fact 0.7); skips short/generic text and anything resembling credentials.
  - `ChatService` integration: retrieves memory via `MemoryService` after model/provider selection and prepends bounded, filtered memorycontext to `systemPrompt` — provider-neutral, identical mechanism for Anthropic and Gemini, historical messages untouched.
  - Typed IPC: `memory:list`, `memory:get`, `memory:update`, `memory:delete`, `memory:search`, `memory:supersede` with Zod validation; preload bridge methods; renderer Memory popover with facts list, scope/category attribution, and delete actions.
  - 26 tests in memory, 56 in storage, 116 in desktop; 497 total tests passing workspace-wide.
- All remaining canonical packages stay **empty shells** (`package.json`, `tsconfig.json`,
  `src/index.ts` placeholder) — deliberately no premature domain functionality inside them.
- Toolchain: TypeScript 5.9.3, ESLint 10.10.0, Vitest 4.1.10, Vite 8.1.0, Prettier 3.9.6,
  Zod 4.4.3.
- CI workflow: install → typecheck → lint → architecture check → test → build → format check.

## Not yet implemented

- Autonomous multi-step Agent loop / tools orchestration — Agent Runtime milestone.
- Full workspace multi-column layout — Workspace milestone.

## Verification

The claims above are checkable:

```sh
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All five succeed across the shared, ai-core, agent-runtime (EventBus), permissions, storage, providers, mcp, skills, execution, memory, and desktop packages,
while future packages remain shells. A repository search finds no future runtime
classes (`AgentLoop`) anywhere in implementation files.
`@modelcontextprotocol/sdk` is strictly isolated within `packages/mcp`; `@anthropic-ai/sdk` and `@google/genai` are strictly isolated within `packages/providers`; Prisma remains confined to `packages/storage`; `electron` is strictly isolated within `apps/desktop`.
