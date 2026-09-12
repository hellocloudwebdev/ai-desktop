// PR28: packages/memory — Public API Surface
//
// Invariants:
//   1. Memory is a separate subsystem from conversation history.
//   2. Scopes: global and project only.
//   3. Sensitive facts are never injected automatically.
//   4. Superseded facts are excluded from default retrieval.
//   5. Project isolation is enforced at retrieval.

export type { RetrieveMemoryOptions, ScoredMemoryFact } from "./core/memory-retriever.js";
export { retrieveRelevantMemories } from "./core/memory-retriever.js";

export type { ExtractMemoryOptions, MemoryFactCandidate } from "./core/memory-extractor.js";
export {
  extractFactsFromMessage,
  extractFactsFromMessageContent,
} from "./core/memory-extractor.js";

export type {
  MemoryServiceOptions,
  BuildMemoryContextOptions,
  MemoryContextSection,
} from "./core/memory-service.js";
export { MemoryService } from "./core/memory-service.js";

// Re-export canonical Memory contracts from ai-core for consumer convenience
export type {
  MemoryFact,
  MemoryScopeLevel,
  MemoryCategory,
  MemorySensitivity,
  CreateMemoryFactInput,
} from "@ai-desktop/ai-core";
export {
  MemoryFactSchema,
  MemoryScopeLevelSchema,
  MemoryCategorySchema,
  MemorySensitivitySchema,
  containsRawCredential,
} from "@ai-desktop/ai-core";
