// PR9: packages/storage — SecretStore Contract
//
// Canonical abstraction over the OS credential/keychain store:
//   Application -> SecretStore -> OS credential store
//
// Invariants (Step 32):
//   - Raw secrets NEVER enter SQLite, AIEvent payloads, logs, errors, or IPC.
//   - get() on a missing credential returns null; backend failures throw
//     SecretBackendError so "missing" and "broken backend" stay distinguishable.
//   - delete() is idempotent.
//   - References are validated before reaching the platform backend.
//   - No secret value is returned by set(); nothing is logged.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";
import type { SecretRef } from "./secret-ref.js";
import { parseSecretRef } from "./secret-ref.js";

/**
 * Error raised when the underlying OS credential backend fails or is
 * unavailable. Distinct from a missing credential (get() -> null).
 */
export class SecretBackendError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("SECRET_BACKEND_ERROR", message, options);
  }
}

/**
 * Canonical secret-store operations. Implementations wrap a specific
 * OS credential facility (Windows Credential Manager, macOS Keychain,
 * Linux Secret Service) behind this interface.
 */
export interface SecretStore {
  /**
   * Stores a secret under the reference. Replaces any existing value for the
   * same reference intentionally. Never returns or logs the secret.
   */
  set(ref: SecretRef, secret: string): Promise<void>;

  /**
   * Retrieves the secret for a reference, or null when no credential exists.
   * Backend failures throw SecretBackendError instead of returning null.
   */
  get(ref: SecretRef): Promise<string | null>;

  /**
   * Removes the credential. Idempotent: deleting a missing reference is a no-op.
   */
  delete(ref: SecretRef): Promise<void>;

  /**
   * Existence check without retrieving the secret value. Preferred over
   * `(await get(ref)) !== null` to minimize secret exposure.
   */
  has(ref: SecretRef): Promise<boolean>;
}

const MAX_SECRET_LENGTH = 65536;

/**
 * Boundary validation shared by all SecretStore implementations:
 * malformed references and malformed secret values are rejected here so they
 * never reach the OS credential store.
 *
 * Pass requireSecret=true on set() operations.
 */
export function validateSecretInputs(ref: SecretRef, secret?: string, requireSecret = false): void {
  // Re-validates through parseSecretRef; branded types may originate from
  // trusted casts, so the boundary check is deliberate, not redundant.
  parseSecretRef(ref);

  if (requireSecret && secret === undefined) {
    throw new TypeError("Secret value is required");
  }

  if (secret !== undefined) {
    if (typeof secret !== "string") {
      throw new TypeError("Secret value must be a string");
    }
    if (secret.length === 0) {
      throw new Error("Secret value must not be empty");
    }
    if (secret.length > MAX_SECRET_LENGTH) {
      throw new Error(`Secret value exceeds maximum length of ${MAX_SECRET_LENGTH} characters`);
    }
  }
}
