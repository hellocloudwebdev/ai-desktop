# ADR-004: Provider Capabilities & Multi-Provider Architecture

- **Status:** Accepted
- **Date:** 2026-09-09 (Updated in PR22)

## Context

The system talks to multiple AI model providers (Anthropic Claude and Google Gemini implemented; others later). Providers differ in
capabilities (streaming, tool use, multimodality, thinking/reasoning, context limits), and the rest of the
system must consume them uniformly instead of special-casing each vendor.

## Decision

The multi-provider architecture establishes strict separation between:

- **Provider**: The service/backend adapter identity (`ProviderId`, `ProviderAdapter`).
- **Model**: Specific model definition and its capabilities (`ModelId`, `ModelDefinition`, `ModelCapability`). Capabilities belong strictly to models, not providers.
- **Profile**: User's configured provider instance (`ProviderProfile`), storing only non-secret credential references (`credentialRef`), never raw credentials.
- **Selection**: Dynamic or persisted pairing of provider and model (`ModelSelection`).

All provider SDKs (`@anthropic-ai/sdk`, `@google/genai`) remain quarantined inside `packages/providers`.
The application routes requests dynamically via `ModelSelectionService` and `ProviderRegistry`.

What is locked:

- All provider SDKs and **SDK-derived types stay inside the `providers` package**
  (CONSTITUTION.md §2.2); the rest of the system consumes provider-neutral abstractions
  from `ai-core`.
- `providers` may depend only on `ai-core` and `shared` (dependency-graph.md).
- Canonical namespaced IDs (e.g. `gemini:gemini-2.5-flash`) are used throughout the application; vendor-native IDs are quarantined at the SDK translation boundary.

## Consequences

- No `@anthropic-ai/*` (or other vendor) dependency may appear before the provider PR.
- Consumers must not import vendor SDK types, or the PR2 boundary rules will reject it.
