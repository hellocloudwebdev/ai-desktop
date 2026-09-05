# ADR-008: MCP (Model Context Protocol)

- **Status:** Accepted (principles locked) — implementation deferred
- **Date:** 2026-09-05

## Context

External tools and services will be integrated via the Model Context Protocol. The MCP
SDK is an external dependency whose types must not leak across the architecture, and the
agent runtime must not be coupled to it.

## Decision

All MCP integration lives in the `mcp` package:

- **MCP SDK types remain inside `mcp`** (CONSTITUTION.md §2.3); other packages consume
  MCP through the abstractions `mcp` exposes.
- **`agent-runtime` never calls the MCP SDK directly** (CONSTITUTION.md §3.2) — it goes
  through `mcp`.
- `mcp` may depend only on `ai-core`, `storage`, `permissions`, and `shared`
  (dependency-graph.md), which is what lets it check tool calls against the permission
  system.

The MCP host design, server lifecycle, and SDK version choice are **not specified here**;
they are defined by the `mcp` implementation PR, which also introduces the SDK dependency.

## Consequences

- No `@modelcontextprotocol/*` (or `@mcp/*`) dependency may appear before the `mcp`
  implementation PR.
- MCP-backed tools are subject to the same permission mediation and `ToolExecutor`
  lifecycle as every other tool (ADR-013).
