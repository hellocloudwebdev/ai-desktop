# ADR-004: Provider Capabilities

- **Status:** Deferred
- **Date:** 2026-09-05

## Context

The system talks to AI model providers (Anthropic first, others later). Providers differ in
capabilities (streaming, tool use, multimodality, context limits), and the rest of the
system must consume them uniformly instead of special-casing each vendor.

## Decision

**Deferred.** The capability model — which capabilities exist, how they are declared,
queried, and degraded — is not specified in Phase 0 and will be defined by the provider
implementation PR rather than invented here.

What is locked now (and therefore not deferred):

- All provider SDKs and **SDK-derived types stay inside the `providers` package**
  (CONSTITUTION.md §2.2); the rest of the system consumes provider-neutral abstractions
  from `ai-core`.
- `providers` may depend only on `ai-core` and `shared` (dependency-graph.md).
- No provider SDK is installed in PR1; the Anthropic implementation arrives in a later PR.

## Consequences

- No `@anthropic-ai/*` (or other vendor) dependency may appear before the provider PR.
- Consumers must not import vendor SDK types, or the PR2 boundary rules will reject it.
