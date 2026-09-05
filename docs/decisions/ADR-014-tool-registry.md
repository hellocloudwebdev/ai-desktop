# ADR-014: Tool Registry

- **Status:** Deferred
- **Date:** 2026-09-05

## Context

Tools will come from multiple sources: built-in tools, MCP servers (ADR-008), and skills
(ADR-009). Something must register, discover, and resolve these tools so the uniform
`ToolExecutor` lifecycle (ADR-013) can apply to all of them.

## Decision

**Deferred.** The registry design — registration API, discovery, naming, conflict
resolution, and how tool definitions from different sources are normalized — is not
specified in Phase 0 and will be designed by the tool-registry implementation PR rather
than invented here.

What is locked now:

- The registry exists so that the **same** `ToolExecutor` lifecycle applies to every tool
  regardless of source; there is no side door around it.
- Permission mediation (ADR-007) applies at the point tools are invoked through this
  mechanism.
- No tool registry implementation exists in PR1.

## Consequences

- Providers, MCP, and skills must surface their capabilities in a form the registry can
  normalize; the deferred capability model (ADR-004) and MCP/skills designs must account
  for this when they land.
