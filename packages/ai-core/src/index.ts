// PR4: packages/ai-core — Canonical AI Domain Layer
//
// Defines the core vocabulary and domain contracts for the ai-desktop system:
// Messages, Multimodal Content, AIEvents, Tools, Permissions, Execution, and Tasks.
//
// Dependency rule:
//   ai-core -> shared (ai-core may ONLY depend on @ai-desktop/shared)

export * from "./identifiers.js";
export * from "./content.js";
export * from "./message.js";
export * from "./tools.js";
export * from "./permissions.js";
export * from "./execution.js";
export * from "./tasks.js";
export * from "./events.js";
export * from "./errors.js";
