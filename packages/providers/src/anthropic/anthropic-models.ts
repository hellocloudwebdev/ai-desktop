// PR11: packages/providers — Anthropic Model Definitions
//
// Invariants:
//   - ModelDefinition owns capabilities (text_generation, streaming, vision, tool_use, thinking).
//   - Models and Provider remain strictly separate.
//   - Uses canonical ModelId and ProviderId from @ai-desktop/ai-core.
//   - Zero Anthropic SDK imports in this file.

import {
  asModelId,
  asProviderId,
  type ModelDefinition,
  type ProviderId,
} from "@ai-desktop/ai-core";

export const ANTHROPIC_PROVIDER_ID: ProviderId = asProviderId("anthropic");

/**
 * Verified canonical Anthropic model definitions for Phase-0/1.
 * Capabilities belong exclusively to each ModelDefinition.
 */
export const ANTHROPIC_MODELS: readonly ModelDefinition[] = [
  {
    id: asModelId("claude-3-5-sonnet-20241022"),
    providerId: ANTHROPIC_PROVIDER_ID,
    displayName: "Claude 3.5 Sonnet",
    description: "Most intelligent model, high-speed coding and complex reasoning.",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: [
      "text_generation",
      "streaming",
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
    ],
  },
  {
    id: asModelId("claude-3-5-haiku-20241022"),
    providerId: ANTHROPIC_PROVIDER_ID,
    displayName: "Claude 3.5 Haiku",
    description: "Fastest, lowest-latency model for rapid responses and lightweight tasks.",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: ["text_generation", "streaming", "vision", "tool_use"],
  },
  {
    id: asModelId("claude-3-opus-20240229"),
    providerId: ANTHROPIC_PROVIDER_ID,
    displayName: "Claude 3 Opus",
    description: "Deep analytical model for nuanced analysis and specialized synthesis.",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    capabilities: ["text_generation", "streaming", "vision", "tool_use"],
  },
];

export const ANTHROPIC_MODEL_MAP: ReadonlyMap<string, ModelDefinition> = new Map(
  ANTHROPIC_MODELS.map((model) => [model.id, model]),
);
