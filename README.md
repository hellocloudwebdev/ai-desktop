# ai-desktop

A desktop AI assistant. This repository is currently at **PR44 — Scheduling & Autonomous Tasks**:
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
batch coalescing, IPC & renderer approval prompt), real MCP integration (`MCPHost` contract,
`InProcessMCPHost`, MCP SDK quarantine, tool discovery, `ToolRegistry`, `McpToolExecutor`),
Skills foundation (`SkillManifestSchema`, package validation, `Installed -> Enabled -> Active` lifecycle,
pre-execution checksum verification, on-demand references), sandboxed execution engine
(`Session != Execution` separation, `DefaultExecutionManager`, `DockerProvider` with non-root
execution, explicit read-only mounts, restricted networking, CPU/memory/PID limits, and
`LocalProcessSandboxProvider`), and the scoped import_guard subsystem (`MemoryFact` contract,
global/project scopes, SQLite `memory_facts` persistence, incremental extraction, deterministic
relevance retrieval, `superseded_by` contradiction handling, project isolation, bounded prompt
injection with sensitivity filtering), and the Agent Runtime orchestration layer (durable
`TaskGraph` skeleton with Kahn DAG validation, per-node ReAct loop over canonical
`tool.call.requested` events, revisable mid-run planning, permission-gated blocking with
approval resume, downward-only cancellation, single transient retry, `EventSink → EventBus →
storage` durability with `projectTaskGraph` replay, project-scoped memory retrieval,
`AgentService` desktop wiring, `agent:start/cancel/get/list` IPC with renderer task progress
surface), and the Coding Agent foundation (canonical coding contracts, workspace-aware
path policy with symlink-escape rejection, bounded filesystem tools, five `builtin:*`
coding tools with definition hashes, validate → permission → backend executor, command
execution through `ExecutionManager`, `CodingAgentService` composing the PR29 runtime,
`coding:start/cancel/get/list` IPC with renderer Coding surface), and the Workspace
composition layer (three-column shell extracted verbatim from the single-column App:
sidebar navigation, main surfaces for chat/coding/tasks/activity/files, selection-driven
inspector, surface-aware composer, collapsible/keyboard-resizable panels with versioned
localStorage persistence, per-surface error boundaries, no new backend/IPC/domain), and the
Extension / Plugin ecosystem foundation (canonical manifest with SemVer + capability
declarations + secret rejection, lifecycle Installed→Enabled→Active→Disabled→Uninstalled,
ExtensionRegistry with SHA-256 trust hashes, SQLite persistence with per-project bindings,
capability-gated host context, `plugin:*` tool contributions through the canonical
ToolRegistry and universal ToolExecutor lifecycle, `extension.custom` event boundary that
cannot forge core events, `extension:*` typed IPC with narrow preload bridge and workspace
Extensions surface), the Rich Surface foundation (canonical descriptors with SemVer +
branded IDs + provenance, host registry with strict lifecycle and hash-match forgery guard,
render/interact permission gates, additive MCP/plugin stamps, `surface:list/get/action/dispose`
IPC with no execute channel, document/table/form renderer with no raw HTML, workspace host +
inspector wiring), and the Browser Automation Foundation (canonical browser contracts,
engine-neutral `BrowserManager`, element reference registry, `PuppeteerAdapter` isolating
`puppeteer-core`, `BrowserToolExecutor` for 11 canonical browser tools, `BrowserService` with
project-isolated sessions and screenshot artifact handling, typed `browser:*` IPC, preload bridge,
and `BrowserSurface` workspace component), and the Web Research & Internet Connectivity
Foundation (canonical research contracts with branded IDs and closed channel vocabulary,
provenance-bearing results, SSRF guard with DNS-rebinding redirect re-validation, bounded
secure HTTP fetch with response limits, per-channel TTL research cache, provider health
ledger with controlled primary → fallback routing, five channel adapters — static web
reader, pluggable search, structured GitHub, YouTube metadata/transcript, dependency-free
RSS/Atom — `ResearchRouter` + `ResearchService` with controlled PR34 `BrowserService`
fallback, `ResearchToolExecutor` under the universal resolve → validate → permission →
execute lifecycle, `research:*` typed IPC with narrow preload bridge, and `ResearchSurface`
workspace component), and the Research Intelligence & Source Synthesis Foundation
(canonical intelligence contracts — research plans, canonical sources with cross-provider
provider ledgers, verbatim evidence with locators, evidence-backed claims, two-sided
conflicts, structured citations, extractive synthesis, versioned research packages with
run provenance — depth budgets across shallow/standard/deep with freshness normalization,
conservative source canonicalizer with cross-provider dedup, budget tracker with bounded
parallelism and cancellation, deterministic evidence extractor with verbatim invariant,
numeric conflict detector, bounded source graph, `ResearchOrchestrator` composing the PR35
`ResearchService` with partial-degradation and zero new persistence, `builtin:research.deep`
under the existing `research` capability, prompt-injection and tool-poisoning isolation,
and the extended `ResearchSurface` evidence/conflict/citation/synthesis panel), and the
Document Intelligence & Project RAG Foundation (canonical document contracts with branded
IDs and validated lifecycle, five-format allowlist with hand-rolled text/Markdown/JSON/CSV
and minimal page-aware PDF parsers, deterministic normalization and bounded page-aware
chunking with stable checksums, deterministic lexical retrieval with relevance-only
scoring, Prisma `DocumentRecord`/`DocumentChunkRecord` project-scoped persistence,
`DocumentService` with within-project dedupe and bounded concurrency, four
`builtin:documents.*` tools under the existing permission architecture with delete gated
high, `documents:*` typed IPC with narrow preload bridge, untrusted-document framing
with PR36-shaped evidence mapping, and the extended Files surface documents panel), and the
Advanced MCP & MCP Apps Foundation (capability contracts with lifecycle machine and
capability discovery over tools/resources/prompts, typed resource retrieval with URI gates
and templates, framed prompt retrieval, per-project subscriptions with TTL cleanup,
structured tool results with server provenance, streamable-http transport, secretRef
resolution with stdio env allowlist, pure MCP App surface bridge into renderable
RichSurface descriptors with validated interactions, desktop host singleton with eleven
typed `mcp:*` IPC commands and preload bridge, MCP Servers workspace surface, and
injection/poisoning/forgery/isolation/secret security tests with full-lifecycle E2E), and the
Multimodal Foundation (canonical text/image/audio/video parts with MIME allowlists and
centralized bounds, attachment lifecycle with validated transitions, capability negotiation
failing before provider execution, Gemini audio/video translation with byte caps and
flash/pro catalog entries, typed Anthropic audio/video errors, multimodal chat parts with
extended negotiation, project-scoped media artifact store with magic-byte and
decompression-bomb validation, attachment metadata persistence, `attachments:*` typed IPC
with preload bridge, Files attachments panel with chat thumbnails, and
traversal/spoof/isolation security tests with vision/isolation/cancellation E2E), and the
Voice & Realtime Foundation (session state machine with validated transitions,
capability negotiation, Gemini Live provider wiring with Anthropic
unsupported-verdict, desktop session lifecycle with per-chunk permission and idempotent
cleanup, final-transcript chat handoff, tool bridge through the universal lifecycle,
nine typed `realtime:*` IPC commands with preload bridge, Voice workspace surface with
microphone indicator and transcripts, and injection/isolation/secret security tests with
lifecycle/interruption/isolation/failure/cancellation E2E), and the
Advanced Coding Workspace (project file service with tree/read/write/create/rename/delete
and mtime conflict detection, bounded cancellable project search, in-memory diagnostics
store, pure bounded LCS diff, sandboxed terminal sessions with output ceiling and
fail-closed stdin, sixteen typed `workspace:*`/`terminal:*` IPC commands with preload
bridge, dependency-free explorer/editor/tabs/search/terminal/diff UI with dirty and
conflict UX, and traversal/symlink/metachar/secret security tests with file, conflict,
search, diagnostics, isolation, and terminal E2E), and the
Git Diff & Review Foundation (canonical Git domain contracts, `GitService` over argv-only
`GitCliClient` with project-scoped path policy, seven canonical `builtin:git.*` tools through
the universal ToolExecutor lifecycle, eight typed `git:*` IPC commands with preload bridge,
`GitReviewSurface` with status groups, hunk-level diff viewer, log/branches panels, and
stage/unstage/commit controls, and traversal/symlink/metachar/secret security tests with
repository, status, diff, commit, isolation, and review E2E), and the Background &
Long-Running Agents foundation (durable background task contracts with nine-state
lifecycle, legal-transition gating, 4-global/2-per-project/16-queue concurrency caps,
resumable vs requires-approval vs abandoned crash-recovery classification, secret
guard, and `task.background.*` event names; `BackgroundTaskManager` thin orchestration
over the existing Agent Runtime with FIFO queueing, idempotent pause/resume/cancel,
permission/input parking with no auto-approval, immutable project binding, and
idempotent recovery that never auto-replays non-idempotent tools; SQLite
`background_tasks` projection persistence with secret refusal; `DesktopBackgroundTaskService`
with startup recovery and seven typed `background-tasks:*` IPC commands plus narrow
preload bridge; Task Center renderer layer with Active and Completed sections plus
Task Detail over background projections with permission approval routed through the
existing permission UI path, waiting-input response box, EventBus timeline with no
separate notification bus, bound-project display isolation, truncation with
secret-assignment redaction, Tasks sidebar counts, and unit/integration/security/E2E
tests), and the Scheduling & Autonomous Tasks foundation (durable
schedule/run contracts with once/delay/interval/daily/weekly kinds and no
cron, IANA timezone handling via built-in Intl, skip/run_once missed-run
policy, skip/queue_one overlap policy, 32-total/8-per-project/60s-minimum/
50-history/1-catch-up caps, pending/running/completed/failed/skipped/
cancelled run statuses, scheduled/manual/recovery triggers, and
`schedule.*` event names; `BackgroundScheduler` core plus
`DesktopSchedulerService` thin orchestration over the PR43
BackgroundTaskManager with a single timer, pending-record-before-launch,
idempotent startup recovery, bounded run history, and delete≠cancel with
post-delete history; SQLite `scheduled_tasks`/`scheduled_runs`
projection persistence with secret refusal; nine typed `schedules:*` IPC
commands plus narrow preload bridge with no execute channel; Schedule
Center renderer layer with narrow `window.api.schedules` bridge client,
Enabled vs Disabled grouping, project-locked schedules, next-run
countdown/duration formatting, Scheduled/Manual/Recovered trigger labels,
name ≤120 / prompt ≤4000 truncation with `key=value` secret-assignment
redaction, full client-side create/edit validation (once/delay/interval/
daily/weekly) with nothing executing from a partial form, 50-row render
caps, schedule list/detail/create-edit form, Run now (labeled Manual) +
Enable/Disable + Delete with an explicit "does not cancel running task"
note, run-history panel with downstream approval resolved only through the
existing permission path (schedule≠grant, never auto-approved), single
bounded 2 s poll with re-query on mount/scope change and no
renderer-local truth, Tasks surface extension plus `schedulesEnabledCount`
sidebar badge, and unit/integration/security/persistence/E2E tests) are
implemented. Future packages remain empty shells awaiting their respective
implementation PRs — see [docs/architecture/phase-0.md](docs/architecture/phase-0.md) for the honest list of what is
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

| Package                     | Role                                                                                                                                             | May depend on                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `@ai-desktop/shared`        | shared contracts & primitives (implemented in PR3)                                                                                               | —                                     |
| `@ai-desktop/ai-core`       | messages, content, events, tools, projections (PR4/PR5)                                                                                          | shared                                |
| `@ai-desktop/providers`     | ProviderAdapter contract, Anthropic (PR11), Gemini (PR21), registry, profiles & model selection (PR19–PR22)                                      | ai-core, shared                       |
| `@ai-desktop/storage`       | persistence (PR8), secrets store (PR9), permission policies & audit (PR24)                                                                       | ai-core, shared                       |
| `@ai-desktop/permissions`   | PermissionManager mediation, policy evaluator, SQLite policy & audit persistence (PR7, PR24)                                                     | ai-core, storage, shared              |
| `@ai-desktop/mcp`           | MCPHost, InProcessMCPHost, tool discovery, ToolRegistry, McpToolExecutor (PR25)                                                                  | ai-core, storage, permissions, shared |
| `@ai-desktop/skills`        | Skill package validation, lifecycle (Installed/Enabled/Active), checksums (PR26)                                                                 | ai-core, storage, shared              |
| `@ai-desktop/execution`     | sandboxed command execution, ExecutionManager, DockerProvider, LocalProcessSandboxProvider (PR27)                                                | ai-core, permissions, storage, shared |
| `@ai-desktop/memory`        | scoped import_guard facts, extractor, retriever, MemoryService (PR28)                                                                            | ai-core, storage, shared              |
| `@ai-desktop/agent-runtime` | in-process EventBus (PR6); TaskGraph + ReAct orchestration runtime (PR29)                                                                        | all of the above                      |
| `@ai-desktop/workspace`     | workspace UI                                                                                                                                     | (later PRs)                           |
| `@ai-desktop/plugins`       | extension & plugin ecosystem foundation (PR32)                                                                                                   | ai-core, shared                       |
| `@ai-desktop/desktop`       | Electron shell, React renderer, typed IPC, ChatService, permissions, skills, memory, agent, workspace, extensions, surfaces, browser (PR12–PR34) | agent-runtime, shared                 |

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
