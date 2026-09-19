// PR45: packages/agent-runtime — LocalAuthProvider (CORE ENGINE layer)
//
// Offline local-profile auth provider behind the SessionAuthProvider port.
// signIn creates (or loads, matched on displayName+email) a local profile
// { accountId, displayName, email? } and mints fresh opaque material per
// grant: a 32-byte hex session nonce (memory-only, held by the session
// manager, never persisted) and an independent 32-byte hex refresh token
// (persisted ONLY in the SecretStore by the manager, never here).
//
// Composition rules:
//   - Canonical-first: identity validation and account ids come from
//     @ai-desktop/ai-core (validateAccountInput, createAccountId). No local
//     id scheme, no secrets schema.
//   - No persistence of its own: profiles live in memory; signOut is a
//     no-op over profiles (local data untouched — re-sign-in loads the same
//     accountId). Nonce clearing + SecretStore refresh-entry deletion belong
//     to AccountSessionManager.signOut, not here.
//   - Nonce quality: crypto.getRandomValues first, deterministic
//     caller-visible fallback only when no secure source exists.
//   - Zero Electron, Prisma, child process spawn, filesystem, or network
//     imports.

import { createAccountId, validateAccountInput } from "@ai-desktop/ai-core";
import { AccountSessionError } from "./account-session-manager.js";
import type { SessionAuthMaterial, SessionAuthProvider } from "./account-session-manager.js";

export interface LocalAuthAccount {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 32 random bytes as 64 lowercase hex characters (opaque, non-secret-shaped). */
export function createOpaqueHex(bytes = 32): string {
  try {
    const cryptoObj = globalThis.crypto as unknown as
      { getRandomValues?: (arr: Uint8Array) => Uint8Array } | undefined;
    if (cryptoObj?.getRandomValues) {
      const buffer = new Uint8Array(bytes);
      cryptoObj.getRandomValues(buffer);
      return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to the last-resort fallback below.
  }
  let out = "";
  while (out.length < bytes * 2) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, bytes * 2);
}

/**
 * Offline local-profile provider. Profiles are keyed by the exact
 * displayName+email pair; unknown pairs create a fresh accountId.
 */
export class LocalAuthProvider implements SessionAuthProvider {
  private readonly _accounts = new Map<string, LocalAuthAccount>();
  private readonly _clock: () => number;

  constructor(options: { readonly clock?: () => number } = {}) {
    this._clock = options.clock ?? Date.now;
  }

  async begin(input: {
    readonly displayName: string;
    readonly email?: string;
  }): Promise<SessionAuthMaterial> {
    let displayName: string;
    let email: string | undefined;
    try {
      const validated = validateAccountInput({
        displayName: (input as { displayName?: unknown }).displayName,
        ...((input as { email?: unknown }).email === undefined
          ? {}
          : { email: (input as { email?: unknown }).email }),
      });
      displayName = validated.displayName;
      email = validated.email;
    } catch (err) {
      throw new AccountSessionError(
        String(err).includes("secret-refused") ? "secret-refused" : "validation-error",
        "sign-in requires displayName 1..120 and optional email 1..256",
      );
    }

    const nowIso = new Date(this._clock()).toISOString();
    const key = `${displayName}\n${email ?? ""}`;
    let account = this._accounts.get(key);
    if (!account) {
      account = {
        accountId: createAccountId(),
        displayName,
        ...(email !== undefined ? { email } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this._accounts.set(key, account);
    } else {
      account = { ...account, updatedAt: nowIso };
      this._accounts.set(key, account);
    }
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      ...(account.email !== undefined ? { email: account.email } : {}),
      nonce: createOpaqueHex(32),
      refreshToken: createOpaqueHex(32),
    };
  }

  async rotate(input: {
    readonly accountId: string;
  }): Promise<{ readonly nonce: string; readonly refreshToken: string }> {
    const accountId = input?.accountId ?? "";
    const known = [...this._accounts.values()].some((a) => a.accountId === accountId);
    if (!known) {
      throw new AccountSessionError("expired", "session expired, sign in again");
    }
    return { nonce: createOpaqueHex(32), refreshToken: createOpaqueHex(32) };
  }

  /**
   * Profile-preserving no-op: local profiles (and therefore local data)
   * survive sign-out; the manager clears the memory nonce and deletes the
   * SecretStore refresh entry.
   */
  async signOut(): Promise<void> {
    return undefined;
  }

  /** Test hook: profile lookup without secret material. */
  getAccount(accountId: string): LocalAuthAccount | null {
    return [...this._accounts.values()].find((a) => a.accountId === accountId) ?? null;
  }
}
