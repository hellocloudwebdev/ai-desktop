# AI Assistant Guide & Repository Context

This document is the canonical reference for any AI coding assistant (ZCode, Claude, Cursor, Copilot, Codex, etc.) working on this repository. Read this file completely before making architectural decisions or proposing dependency upgrades.

---

## 1. Project Overview

- **Project:** `ai-desktop`
- **Scope:** Modular desktop AI assistant built as a pnpm/Turborepo monorepo (`@ai-desktop/*`).
- **Core Principle:** **Events are the authoritative source of truth.** Messages and state are pure, deterministic projections reconstructed from immutable event streams.
- **Repository URL:** [https://github.com/hellocloudwebdev/ai-desktop](https://github.com/hellocloudwebdev/ai-desktop)

---

## 2. Inviolable Constitutional Rules

The rules defined in `docs/architecture/CONSTITUTION.md` are normative and mechanically enforced:

1. **Process Isolation:** Never import Electron outside `apps/desktop`. All domain packages under `packages/` must remain Electron-agnostic.
2. **Storage Isolation:** Never import Prisma or `@prisma/client` outside `packages/storage`.
3. **Provider Isolation:** Provider SDK types (Anthropic, OpenAI, etc.) must remain strictly quarantined within `packages/providers`.
4. **MCP Isolation:** `@modelcontextprotocol/*` SDK types remain strictly within `packages/mcp`.
5. **Execution Containment:** `packages/agent-runtime` never calls Docker directly (all container/process lifecycle belongs in `packages/execution`).
6. **Permission Checkpoint:** All tool executions must be mediated through `PermissionManager`.
7. **Append-Only Immutability:** Historical `AIEvent`s are immutable and strictly append-only. Zero `update` or `delete` APIs exist for events.
8. **Unique Sequencing:** `UNIQUE(conversationId, sequence)` is strictly enforced per conversation.
9. **No Raw Secrets in DB:** API keys, OAuth tokens, and secrets must never be stored raw in SQLite. Only secure references are stored; secrets live in the OS keychain.
10. **Single Tool Lifecycle:** Every tool follows the same resolution, permission, and execution pipeline.
11. **Idempotent Operations:** Cancellation and unsubscription operations are always idempotent.

---

## 3. Package Architecture & Dependency Allowlist

The dependency graph is locked in `docs/architecture/dependency-graph.json` and mechanically enforced by `scripts/validate-dependencies.mjs` and `eslint-plugin-boundaries`:

```text
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
                          mcp
                              │
                       agent-runtime
                              │
                           desktop
```

### Strict Rules:

- `shared`: Depends on **nothing**.
- `ai-core`: Depends only on `shared`.
- `storage`: Depends on `ai-core`, `shared`, and internal Prisma.
- `permissions`: Depends on `ai-core`, `shared` (and future `storage`).
- `agent-runtime`: In-process EventBus (PR6); full orchestration is deferred.
- **Shells Stay Empty:** Do not prematurely implement future packages (`providers`, `mcp`, `skills`, `execution`, `memory`, `desktop`, `plugins`) until their dedicated PR milestone.

---

## 4. Locked Toolchain & Version Baseline

Do **NOT** "helpfully" upgrade package versions without a verified toolchain compatibility pass:

| Component                    | Pinned Version             | Architectural Reason                                                                        |
| :--------------------------- | :------------------------- | :------------------------------------------------------------------------------------------ |
| **Node.js**                  | `>= 22` (tested on `24.x`) | LTS foundation matching Vite 8 requirements                                                 |
| **pnpm**                     | `11.25.0`                  | Pinned via root `package.json` `packageManager`                                             |
| **Turborepo**                | `2.10.12`                  | Monorepo build and task orchestration                                                       |
| **TypeScript**               | `5.9.3`                    | **Do NOT upgrade to TypeScript 7.x.** `typescript-eslint` officially supports TS `< 6.1.0`. |
| **ESLint**                   | `10.10.0`                  | Flat config foundation                                                                      |
| **typescript-eslint**        | `^8.69.0`                  | Strict type linting                                                                         |
| **eslint-plugin-boundaries** | `7.2.0`                    | AST-level architecture boundary enforcement                                                 |
| **Vitest**                   | `4.1.10`                   | Unit test runner                                                                            |
| **Vite**                     | `8.1.0`                    | Pinned peer foundation                                                                      |
| **Zod**                      | `4.4.3`                    | Schema validation at process and contract boundaries                                        |
| **Prisma**                   | `6.4.1`                    | SQLite persistence with WAL mode strictly inside `storage`                                  |
| **@napi-rs/keyring**         | `2.0.0`                    | Native OS keychain binding (Windows Credential Manager / macOS / Linux) inside `storage`    |
| **@anthropic-ai/sdk**        | `0.124.0`                  | Official Anthropic SDK strictly inside `packages/providers`                                 |
| **Electron**                 | `44.0.0`                   | Desktop application shell strictly inside `apps/desktop`                                    |
| **React**                    | `19.2.8`                   | Frontend UI library strictly inside `apps/desktop`                                          |
| **Tailwind CSS**             | `4.3.3`                    | Utility-first CSS styling via `@tailwindcss/vite` in `apps/desktop`                         |

---

## 5. Milestone Implementation Status

| Milestone | Branch                                   | Status   | Deliverables                                                                                     |
| :-------- | :--------------------------------------- | :------- | :----------------------------------------------------------------------------------------------- |
| **PR1**   | `main` (`49a99af`)                       | Complete | Workspace foundation, Turbo, docs, package shells                                                |
| **PR2**   | `pr2-dependency-enforcement` (`d2a2335`) | Complete | Machine-readable dependency graph, ESLint boundaries, validator                                  |
| **PR3**   | `pr3-shared-contracts` (`7c93c6a`)       | Complete | Branded ULIDs, Result, BaseError, Timestamp, typed IPC schemas                                   |
| **PR4**   | `pr4-ai-core` (`bb07eaf`)                | Complete | Multimodal ContentPart, Message, ToolSource != ToolRuntime, AIEvent union                        |
| **PR5**   | `pr5-projections` (`6b929f5`)            | Complete | Pure deterministic projections: `projectMessages`, `projectConversation`, `projectTaskGraph`     |
| **PR6**   | `pr6-event-bus` (`9f8fc47`)              | Complete | Thin in-process EventBus, FIFO ordering, re-entrancy queue, error isolation                      |
| **PR7**   | `pr7-permissions` (`0d3e2c1`)            | Complete | `PermissionManager` interface, 5-dimension check, `AllowAllPermissionManager`                    |
| **PR8**   | `pr8-storage` (`bc27f6b`)                | Complete | Prisma SQLite WAL mode, `PrismaEventRepository` append-only storage                              |
| **PR9**   | `pr9-secrets`                            | Complete | `SecretStore`, `SecretRef`, `@napi-rs/keyring` OS keychain integration, 14 unit tests            |
| **PR10**  | `pr10-providers`                         | Complete | Canonical `ProviderAdapter` contract, capabilities, `ChatRequest`, error boundary, 9 tests       |
| **PR11**  | `pr11-anthropic`                         | Complete | Anthropic concrete adapter, request/stream/error translation, cancellation, 26 unit tests        |
| **PR12**  | `pr12-desktop-shell`                     | Complete | Electron 44 shell, secure BrowserWindow, preload bridge, React 19 / Tailwind 4 renderer, 2 tests |
| **PR13**  | `pr13-typed-ipc`                         | Complete | Typed IPC commands/subscriptions, Zod main validation, preload `window.api`, 7 tests             |
| **PR14**  | `pr14-active-stream-registry`            | Complete | `ActiveStreamRegistry` mapping MessageId to AbortController, stream cancellation, 11 tests       |
| **PR15**  | `pr15-ipc-batcher`                       | Complete | `IpcBatcher` ~32 ms batching, terminal immediate flush, WebContents cleanup, 20 tests            |
| **PR16**  | `pr16-first-conversation`                | Complete | First vertical conversation slice, ChatService, streaming UI, SQLite restart recovery, 49 tests  |
| **PR17**  | `pr17-persistence-integration`           | Complete | EventBus storage consumer, sequence continuity, SQLite WAL recovery & replay, 59 tests           |
| **PR18+** | —                                        | **NEXT** | Phase 1 Acceptance Gate, Tool Execution, MCP, Multi-turn Agent Loop                              |

---

## 6. Verification Commands

Before completing any task, ensure all validation gates pass with zero errors:

```bash
pnpm format:check       # Prettier code formatting check
pnpm architecture:check # Enforces dependency declarations, graph edges, and Electron isolation
pnpm typecheck          # TypeScript check across all packages via Turbo
pnpm lint               # ESLint across all packages with boundary rules
pnpm test               # All package unit tests + root validator tests via Vitest
pnpm build              # Compiles all active packages to dist/ with declaration maps
```

Negative verification checks must also pass:

- Zero imports of `@prisma/client` outside `packages/storage`.
- Zero imports of `electron` outside `apps/desktop`.
- Zero raw credentials or secrets committed to SQLite or git.
