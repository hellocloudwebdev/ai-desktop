// PR9: packages/storage — OS Keychain SecretStore Implementation
//
// Wraps the operating system's native credential facility (@napi-rs/keyring 2.0.0)
// behind the canonical SecretStore interface:
//   - Windows Credential Manager (win32)
//   - macOS Keychain (darwin)
//   - Linux Secret Service / keyutils (linux)
//
// Mapping model:
//   SecretRef "app/provider/anthropic/api-key"
//     service = "ai-desktop" (canonical service namespace)
//     account = ref itself ("app/provider/anthropic/api-key")
//
// Invariants (Step 32):
//   - Raw secrets NEVER enter SQLite, AIEvent payloads, logs, errors, or IPC.
//   - get() on missing returns null.
//   - delete() is idempotent (returns boolean or throws on missing; mapped to void).
//   - Backend failures throw SecretBackendError (never null).
//   - Errors NEVER leak the secret value.

import { Entry } from "@napi-rs/keyring";
import type { SecretRef } from "./secret-ref.js";
import { SecretBackendError, validateSecretInputs, type SecretStore } from "./secret-store.js";

export interface OSSecretStoreOptions {
  /**
   * Top-level service namespace used in the OS keychain (e.g. "ai-desktop").
   * Defaults to "ai-desktop".
   */
  readonly serviceName?: string;
}

export class OSKeychainSecretStore implements SecretStore {
  readonly serviceName: string;

  constructor(options?: OSSecretStoreOptions) {
    this.serviceName = options?.serviceName ?? "ai-desktop";
  }

  async set(ref: SecretRef, secret: string): Promise<void> {
    validateSecretInputs(ref, secret, true);

    try {
      const entry = new Entry(this.serviceName, ref);
      entry.setPassword(secret);
    } catch (err: unknown) {
      throw new SecretBackendError(
        `Failed to store credential in OS keychain: ${sanitizeErrorMessage(err)}`,
        { cause: err },
      );
    }
  }

  async get(ref: SecretRef): Promise<string | null> {
    validateSecretInputs(ref);

    try {
      const entry = new Entry(this.serviceName, ref);
      const value = entry.getPassword();
      return value ?? null;
    } catch (err: unknown) {
      // In @napi-rs/keyring, a non-existent password returns null rather than throwing.
      // Any thrown exception is an actual backend failure.
      throw new SecretBackendError(
        `Failed to retrieve credential from OS keychain: ${sanitizeErrorMessage(err)}`,
        { cause: err },
      );
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    validateSecretInputs(ref);

    try {
      const entry = new Entry(this.serviceName, ref);
      // deletePassword() returns true if deleted, false if did not exist.
      // Both outcomes fulfill idempotent deletion cleanly.
      entry.deletePassword();
    } catch (err: unknown) {
      throw new SecretBackendError(
        `Failed to delete credential from OS keychain: ${sanitizeErrorMessage(err)}`,
        { cause: err },
      );
    }
  }

  async has(ref: SecretRef): Promise<boolean> {
    validateSecretInputs(ref);

    try {
      const entry = new Entry(this.serviceName, ref);
      const value = entry.getPassword();
      return value !== null && value !== undefined;
    } catch (err: unknown) {
      throw new SecretBackendError(
        `Failed to inspect credential existence in OS keychain: ${sanitizeErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * Strips any potential secret-like tokens or sensitive traces from native backend error strings.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(/(=)[^\s]+/g, "=[REDACTED]");
  }
  return String(err);
}
