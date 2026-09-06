// PR5: packages/ai-core — Projection Layer Public Surface
//
// Canonical read models projected deterministically from immutable event streams:
//   - projectMessages(events)
//   - projectConversation(events)
//   - projectTaskGraph(events, taskId)

export * from "./helpers.js";
export * from "./messages.js";
export * from "./conversation.js";
export * from "./task-graph.js";
