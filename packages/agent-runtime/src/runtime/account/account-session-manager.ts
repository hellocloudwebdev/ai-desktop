// PR45: packages/agent-runtime — AccountSessionManager (CORE ENGINE layer)
//
// Strict account session state machine over injected ports. The manager owns
// the canonical session lifecycle (signed_out/authenticating/authenticated/
// refreshing/expired/error with the canonical legal-transition map) and
// nothing else: it holds the opaque session nonce memory-only, persists the
// refresh token ONLY through the injected SecretStore port under
// `app/account/<accountId>/refresh-token`, and stops sync through an
// injectable onSyncStop callback.
//
// Composition rules:
//   - Canonical-first: session statuses, the legal-transition map, input
//     validation, and id factories come from @ai-desktop/ai-core
//     (AccountSessionStatusSchema, SESSION_TRANSITIONS,
//     isLegalSessionTransition, validateAccountInput, parseAccountId,
//     createDeviceId, AccountSessionSchema). No local status mirrors.
//   - Structural ports only: SessionAuthProvider (async begin/rotate/
//     signOut) and SessionSecretStore (set/get/delete over string refs) are
//     defined here so this package never imports @ai-desktop/storage or
//     apps/desktop (both would violate the dependency allowlist). Method
//     syntax keeps the ports structurally assignable from the real
//     implementations (bivariant methods).
//   - Secrets: the session object carries ids + status + timestamps only,
//     NEVER tokens or nonces. Refresh failure (missing/rotating/storing the
//     grant) always lands in expired. signOut clears the memory nonce,
//     deletes the SecretStore refresh entry (best-effort), invokes
//     onSyncStop (best-effort), and moves to signed_out from ANY state.
//     Local account/device rows are untouched: this file has no repository
//     port at all, so sign-out cannot delete local data by construction.
//   - Zero Electron, Prisma, child process spawn, filesystem, or network
//     imports. Time comes from an injectable clock.

import {
  AccountSessionSchema,
  createDeviceId,
  isLegalSessionTransition,
  parseAccountId,
  validateAccountInput,
  type AccountSession,
  type AccountSessionStatus,
} from "@ai-desktop/ai-core";

// ---------------------------------------------------------------------------
// Ports (structural; providers and secret stores are injected, never imported)
// ---------------------------------------------------------------------------

/** Opaque auth material minted by the provider (never persisted by the manager). */
export interface SessionAuthMaterial {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly nonce: string;
  readonly refreshToken: string;
}

/** Async auth boundary behind the session machine (local or future remote). */
export interface SessionAuthProvider {
  begin(input: {
    readonly displayName: string;
    readonly email?: string;
  }): Promise<SessionAuthMaterial>;
  rotate(input: { readonly accountId: string }): Promise<{
    readonly nonce: string;
    readonly refreshToken: string;
  }>;
  signOut(accountId: string): Promise<void> | void;
}

/**
 * Minimal SecretStore view. Declared with methods (not properties) so the
 * real storage SecretStore remains structurally assignable.
 */
export interface SessionSecretStore {
  set(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

export interface AccountSessionManagerOptions {
  readonly authProvider: SessionAuthProvider;
  readonly secretStore: SessionSecretStore;
  /**
   * Stable device identity factory (persisted per installation by the
   * caller; defaults to an in-memory cached ULID). The injected factory is
   * expected to draw on crypto.getRandomValues (as generateUlid does).
   */
  readonly getOrCreateDeviceId?: () => string | Promise<string>;
  readonly clock?: () => number;
  /** Stop-sync callback invoked (best-effort) on every sign-out. */
  readonly onSyncStop?: () => void | Promise<void>;
}

export interface SessionSignInInput {
  readonly displayName: string;
  readonly email?: string;
}

export class AccountSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[account-session:${code}] ${message}`);
    this.name = "AccountSessionError";
    this.code = code;
  }
}

/**
 * SecretStore reference for one account's refresh token. Lowercased so the
 * ULID accountId satisfies the lowercase SecretRef segment rules.
 */
export function accountRefreshTokenRef(accountId: string): string {
  return `app/account/${accountId.toLowerCase()}/refresh-token`;
}

// ---------------------------------------------------------------------------
// AccountSessionManager
// ---------------------------------------------------------------------------

const STARTABLE_FROM: readonly AccountSessionStatus[] = ["signed_out", "expired", "error"];

export class AccountSessionManager {
  private readonly _auth: SessionAuthProvider;
  private readonly _secrets: SessionSecretStore;
  private readonly _getOrCreateDeviceId: () => string | Promise<string>;
  private readonly _clock: () => number;
  private readonly _onSyncStop?: () => void | Promise<void>;
  private readonly _nonces = new Map<string, string>();
  private _status: AccountSessionStatus = "signed_out";
  private _session: AccountSession | null = null;
  private _deviceIdCache: string | null = null;

  constructor(options: AccountSessionManagerOptions) {
    if (!options || typeof options !== "object") {
      throw new AccountSessionError("invalid-options", "AccountSessionManager requires options");
    }
    if (!options.authProvider || !options.secretStore) {
      throw new AccountSessionError(
        "invalid-options",
        "AccountSessionManager requires authProvider + secretStore",
      );
    }
    this._auth = options.authProvider;
    this._secrets = options.secretStore;
    this._getOrCreateDeviceId =
      options.getOrCreateDeviceId ?? (() => (this._deviceIdCache ??= createDeviceId()) as string);
    this._clock = options.clock ?? Date.now;
    if (options.onSyncStop) this._onSyncStop = options.onSyncStop;
  }

  getStatus(): AccountSessionStatus {
    return this._status;
  }

  /** Current session snapshot (ids + status + timestamps; never secrets). */
  getSession(): AccountSession | null {
    return this._session === null ? null : { ...this._session };
  }

  getAccountId(): string | null {
    return this._session?.accountId ?? null;
  }

  /** Test hook: whether a memory-only nonce is held (never the value). */
  hasNonce(accountId: string): boolean {
    return this._nonces.has(accountId);
  }

  async signIn(input: SessionSignInInput): Promise<AccountSession> {
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

    const from = this.getStatus();
    if (!(STARTABLE_FROM as readonly string[]).includes(from)) {
      throw new AccountSessionError("invalid-transition", `cannot sign in from session "${from}"`);
    }
    this._transition("authenticating");

    let deviceId: string;
    try {
      deviceId = (await this._getOrCreateDeviceId()).trim();
      if (deviceId.length === 0) throw new Error("empty device id");
    } catch {
      this._transition("error");
      throw new AccountSessionError("invalid-device", "stable device identity unavailable");
    }

    let material: SessionAuthMaterial;
    try {
      material = await this._auth.begin({
        displayName,
        ...(email !== undefined ? { email } : {}),
      });
      if (!material || !material.nonce || !material.refreshToken || !material.accountId) {
        throw new Error("incomplete grant");
      }
    } catch (err) {
      this._transition("error");
      if (err instanceof AccountSessionError) throw err;
      throw new AccountSessionError("auth-failed", "sign-in failed");
    }

    let accountId: string;
    try {
      accountId = parseAccountId(material.accountId);
    } catch {
      this._transition("error");
      throw new AccountSessionError("validation-error", "provider returned an invalid accountId");
    }

    try {
      await this._secrets.set(accountRefreshTokenRef(accountId), material.refreshToken);
    } catch {
      this._transition("error");
      throw new AccountSessionError("storage-error", "credential storage unavailable");
    }

    this._nonces.set(accountId, material.nonce);
    this._session = AccountSessionSchema.parse({
      accountId,
      deviceId,
      status: "authenticating",
      createdAt: new Date(this._clock()).toISOString(),
    });
    this._transition("authenticated");
    return { ...this._session };
  }

  async refresh(): Promise<AccountSession> {
    const current = this._session;
    if (current === null || current.status !== "authenticated") {
      throw new AccountSessionError(
        current === null ? "not-signed-in" : "invalid-transition",
        current === null
          ? "no account is signed in"
          : `cannot refresh from session "${current.status}"`,
      );
    }
    this._transition("refreshing");
    const accountId = current.accountId;

    let stored: string | null;
    try {
      stored = await this._secrets.get(accountRefreshTokenRef(accountId));
    } catch {
      return this._expire("credential storage unavailable");
    }
    if (!stored) {
      return this._expire("session expired, sign in again");
    }

    let rotated: { readonly nonce: string; readonly refreshToken: string };
    try {
      rotated = await this._auth.rotate({ accountId });
      if (!rotated || !rotated.nonce || !rotated.refreshToken) {
        throw new Error("incomplete rotation");
      }
    } catch (err) {
      if (err instanceof AccountSessionError) {
        return this._expire(err.message);
      }
      return this._expire("session expired, sign in again");
    }

    try {
      await this._secrets.set(accountRefreshTokenRef(accountId), rotated.refreshToken);
    } catch {
      return this._expire("credential storage unavailable");
    }

    this._nonces.set(accountId, rotated.nonce);
    this._session = {
      ...current,
      status: "refreshing",
      lastRefreshAt: new Date(this._clock()).toISOString(),
    };
    this._transition("authenticated");
    return { ...this._session };
  }

  /**
   * Idempotent sign-out from ANY state: clears the memory nonce, deletes
   * the SecretStore refresh entry (best-effort), invokes onSyncStop
   * (best-effort), and lands in signed_out. Local data is untouched.
   */
  async signOut(): Promise<{ readonly signedOut: true; readonly accountId: string | null }> {
    const accountId = this._session?.accountId ?? null;
    if (accountId !== null) {
      this._nonces.delete(accountId);
      try {
        await this._secrets.delete(accountRefreshTokenRef(accountId));
      } catch {
        // Credential cleanup is best-effort; sign-out still completes.
      }
    }
    if (this._onSyncStop) {
      try {
        await this._onSyncStop();
      } catch {
        // Sync teardown never fails sign-out.
      }
    }
    this._transition("signed_out");
    this._session = null;
    return { signedOut: true, accountId };
  }

  private _expire(message: string): never {
    this._transition("expired");
    throw new AccountSessionError("expired", message);
  }

  private _transition(to: AccountSessionStatus): void {
    const from = this._status;
    if (from === to) return;
    if (!isLegalSessionTransition(from, to)) {
      throw new AccountSessionError(
        "invalid-transition",
        `cannot transition session from "${from}" to "${to}"`,
      );
    }
    this._status = to;
    if (this._session !== null) {
      this._session = { ...this._session, status: to };
    }
  }
}
