// PR8: packages/storage — Public API Surface
//
// Clean storage abstractions. PrismaClient and internal database queries
// strictly remain behind this package boundary.

export type { DatabaseOptions } from "./client/database.js";
export { StorageDatabase } from "./client/database.js";

export type { EventRepository } from "./events/event-repository.js";
export {
  PrismaEventRepository,
  StorageError,
  DuplicateSequenceError,
} from "./events/prisma-event-repository.js";

// PR9: Secrets abstraction & OS keychain implementation
export * from "./secrets/index.js";
