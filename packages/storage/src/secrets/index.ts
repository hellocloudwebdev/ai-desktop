// PR9: packages/storage — Secrets Module Public API
//
// Canonical secret abstractions and the OS-backed implementation.
// Prisma and SQLite never handle raw secrets; only SecretRef references.

export type { SecretRef } from "./secret-ref.js";
export { parseSecretRef, isSecretRef, asSecretRef, SecretRefSchema } from "./secret-ref.js";

export type { SecretStore } from "./secret-store.js";
export { SecretBackendError, validateSecretInputs } from "./secret-store.js";

export type { OSSecretStoreOptions } from "./os-secret-store.js";
export { OSKeychainSecretStore } from "./os-secret-store.js";
