# ADR-012: Agent Runtime

- **Status:** Deferred (composition role locked)
- **Date:** 2026-09-05

## Context

The agent runtime orchestrates everything: model calls, tools, permissions, MCP, skills,
execution, memory, and persistence. It is the layer where a wrong coupling decision would
contaminate the whole architecture.

## Decision

`agent-runtime` is a **pure composition layer**:

- **It remains Electron-agnostic** (CONSTITUTION.md §1.2) — it must run in a plain
  Node.js context, so the runtime logic stays testable and reusable independent of the
  desktop shell.
- It sits on top of every domain package per the dependency graph and never reaches
  around them: it does not call Docker directly (ADR-011) and does not call the MCP SDK
  directly (ADR-008).
- It may depend on `ai-core`, `providers`, `permissions`, `mcp`, `skills`, `execution`,
  `memory`, `storage`, and `shared` (dependency-graph.md).

The runtime's internals — its event loop, scheduling, and the `EventBus` that will carry
events — are **not specified here**; they are designed by the agent-runtime implementation
PR. No `EventBus` or agent loop exists in PR1.

## Consequences

- `desktop` (ADR-001) is a thin shell over `agent-runtime`, not a second brain: business
  logic never moves into the Electron layer.
- Everything below the runtime stays independently testable in Node.
