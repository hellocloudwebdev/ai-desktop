// PR21.2: packages/providers — Google Gemini Model Definitions
//
// Invariants (Step 41 / PR21):
//   1. ModelDefinition owns capabilities (text_generation, streaming, vision, tool_use, thinking, structured_output).
//   2. Models and Provider remain strictly separate.
//   3. Uses canonical ModelId and ProviderId from @ai-desktop/ai-core.
//   4. Zero Gemini SDK (@google/genai) imports in this file (locked architectural boundary).
//   5. Capabilities are mapped conservatively: Flash-Lite does NOT declare thinking.

import {
  asModelId,
  asProviderId,
  type ModelDefinition,
  type ProviderId,
} from "@ai-desktop/ai-core";

export const GEMINI_PROVIDER_ID: ProviderId = asProviderId("gemini");

/**
 * Verified canonical Gemini model definitions for Phase 2.
 * Capabilities belong exclusively to each ModelDefinition.
 */
export const GEMINI_MODELS: readonly ModelDefinition[] = [
  {
    id: asModelId("gemini:gemini-2.5-flash"),
    providerId: GEMINI_PROVIDER_ID,
    displayName: "Gemini 2.5 Flash",
    description: "High-volume, low-latency multimodal reasoning and general intelligence model.",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    capabilities: [
      "text_generation",
      "streaming",
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
    ],
    metadata: {
      nativeModelId: "gemini-2.5-flash",
    },
  },
  {
    id: asModelId("gemini:gemini-2.5-flash-lite"),
    providerId: GEMINI_PROVIDER_ID,
    displayName: "Gemini 2.5 Flash-Lite",
    description: "Fastest, budget-optimized multimodal model for high-throughput tasks.",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    capabilities: ["text_generation", "streaming", "vision", "tool_use", "structured_output"],
    metadata: {
      nativeModelId: "gemini-2.5-flash-lite",
    },
  },
  {
    id: asModelId("gemini:gemini-2.5-pro"),
    providerId: GEMINI_PROVIDER_ID,
    displayName: "Gemini 2.5 Pro",
    description: "Advanced reasoning and coding model for complex multi-turn problem solving.",
    contextWindow: 2097152,
    maxOutputTokens: 8192,
    capabilities: [
      "text_generation",
      "streaming",
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
    ],
    metadata: {
      nativeModelId: "gemini-2.5-pro",
    },
  },
];

export const GEMINI_MODEL_MAP: ReadonlyMap<string, ModelDefinition> = new Map(
  GEMINI_MODELS.map((model) => [model.id, model]),
);
