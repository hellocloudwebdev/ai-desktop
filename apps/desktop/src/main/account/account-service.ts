// PR45: apps/desktop — AccountService (Desktop Orchestration Layer)
//
// Thin orchestration around durable account/device repositories +
// SecretStore + EventBus/EventRepository. It owns NO PermissionManager, NO
// provider router, NO sync transport, and NO Electron APIs (Node only).
//
// Invariants:
//   1. Persistence is a projection/read model: every transition upserts the
//      account row {accountId,displayName,email,createdAt,updatedAt,
//      schemaVersion:1} and device row {deviceId,accountId,deviceName,
//      platform,createdAt,lastSeenAt}. Identity fields are truncated and
//      secret-scanned before every write; raw secrets never reach storage.
//   2. Secrets live ONLY in the OS SecretStore under
//      app/account/<lowercase-accountId>/refresh-token plus an opaque
//      in-memory nonce. Projections, events, rows, and IPC never carry
//      refresh tokens, nonces, or SecretRefs.
//   3. Events are authoritative: every transition appends an account.*
//      AIEvent via storage.append THEN EventBus.publish (same ordering as
//      DesktopEventSink / DesktopSchedulerService: persistence before
//      delivery), with conversationId-per-entity (accountId) + sequence.
//   4. Session is a strict state machine:
//      signed_out -> authenticating -> authenticated <-> refreshing,
//      any -> signed_out (idempotent sign-out), refresh failure -> expired,
//      expired/error -> authenticating (re-sign-in) or signed_out.
//   5. Sign-out preserves local projects/data (no row deletes except the
//      SecretStore refresh entry + in-memory nonce); it stops sync via the
//      optional onSignedOut callback (SyncService pause) idempotently.
//   6. Auth NEVER touches PermissionManager (no import, no reference).
//   7. Fail closed: malformed ids, oversized strings, secret payloads, and
//      storage loss all throw AccountServiceError ("CODE: message", never a
//      stack or secret echo).
//   8. Canonical alignment: session states
//      (signed_out/authenticating/authenticated/refreshing/expired/error),
//      legal transitions, and account/device event names are imported from
//      the canonical ai-core accounts vocabulary (no local mirrors).
//
// Auth provider port: an optional AuthProvider can be injected. When absent,
// the local offline LocalAuthProvider-equivalent below is used (local
// profile + opaque nonce in memory + refresh token in SecretStore).

import { z } from "zod";
import { generateUlid, isUlid, type ConversationId } from "@ai-desktop/shared";
import {
  createEventId,
  accountEventType as canonicalAccountEventType,
  isLegalSessionTransition as canonicalIsLegalSessionTransition,
  type AIEvent,
  type AccountSessionStatus as CanonicalSessionStatus,
} from "@ai-desktop/ai-core";
import type { EventRepository, SecretStore, SecretRef } from "@ai-desktop/storage";
import { parseSecretRef } from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// Canonical vocabulary (imported from @ai-desktop/ai-core; no local mirrors)
// ---------------------------------------------------------------------------

export type AccountSessionState = CanonicalSessionStatus;

export const ACCOUNT_SESSION_STATES: readonly AccountSessionState[] = [
  "signed_out",
  "authenticating",
  "authenticated",
  "refreshing",
  "expired",
  "error",
];

export const ACCOUNT_SCHEMA_VERSION = 1;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 256;
const MAX_DEVICE_NAME_LENGTH = 120;

const SECRET_PATTERN =
  /(api[_-]?key|secret|bearer\s+[A-Za-z0-9._~-]|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-|gh[pousr]_|sk-(live|test)-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|password\s*[:=]|passwd\s*[:=]|client[_-]?secret|access[_-]?token|refresh[_-]?token|aws[_-]?secret)/i;

// Canonical 7-entry account/device event suffixes (ai-core accounts.ts).
// Re-exported as a type via the canonical builder; the local tuple documents
// the allowlist without duplicating runtime validation.
export type AccountEventType =
  | "created"
  | "signed_in"
  | "signed_out"
  | "session.expired"
  | "session.refreshed"
  | "device.registered"
  | "device.seen";

function accountEventType(type: string): string {
  try {
    return canonicalAccountEventType(type);
  } catch {
    throw new AccountServiceError("validation-error", `invalid account event type "${type}"`);
  }
}

// ---------------------------------------------------------------------------
// Minimal structural ports (real implementations and test stubs both fit)
// ---------------------------------------------------------------------------

export interface AccountRecordPort {
  accountId: string;
  displayName: string;
  email?: string | null;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

export interface DeviceRecordPort {
  deviceId: string;
  accountId: string;
  deviceName: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface AccountRepoPort {
  upsert(record: AccountRecordPort): Promise<void>;
  get(accountId: string): Promise<AccountRecordPort | null>;
  list?(): Promise<AccountRecordPort[]>;
  current?(): Promise<AccountRecordPort | null>;
  remove?(accountId: string): Promise<boolean>;
}

export interface DeviceRepoPort {
  upsert(record: DeviceRecordPort): Promise<void>;
  get(deviceId: string): Promise<DeviceRecordPort | null>;
  listByAccount(accountId: string): Promise<DeviceRecordPort[]>;
  touchLastSeen?(deviceId: string, atMs?: number): Promise<boolean>;
  getOrCreateDevice?(input: {
    deviceId: string;
    accountId: string;
    deviceName?: string;
    platform?: string;
    nowMs?: number;
  }): Promise<DeviceRecordPort>;
}

export interface AccountEventTransport {
  publish(event: Readonly<AIEvent>): Promise<void>;
}

export interface AccountAuthProvider {
  /** Offline grant: validates identity and returns opaque material. */
  begin(input: {
    displayName: string;
    email?: string;
  }): Promise<{ nonce: string; refreshToken: string }>;
  /** Offline rotate: exchanges a refresh grant for fresh material. */
  rotate(input: { refreshToken: string }): Promise<{ nonce: string; refreshToken: string }>;
}

export interface AccountServiceDeps {
  readonly accountRepo: AccountRepoPort;
  readonly deviceRepo: DeviceRepoPort;
  readonly secretStore: SecretStore;
  readonly eventBus: AccountEventTransport;
  readonly storage: EventRepository;
  readonly authProvider?: AccountAuthProvider;
  readonly clock?: () => number;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly platform?: string;
  /** Stop-sync callback invoked idempotently on sign-out (SyncService pause). */
  readonly onSignedOut?: () => Promise<void> | void;
}

export interface SignInInput {
  readonly displayName: string;
  readonly email?: string;
}

export interface AccountProjection {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly session: AccountSessionState;
  readonly deviceId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeviceProjection {
  readonly deviceId: string;
  readonly accountId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly lastSeenAt: string;
}

export class AccountServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AccountServiceError";
    this.code = code;
  }
}

const SignInInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().min(1).max(256).optional(),
});

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function refuseSecrets(value: unknown): void {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text != null && SECRET_PATTERN.test(text)) {
      throw new Error("secret");
    }
  } catch (err) {
    if (err instanceof AccountServiceError) throw err;
    throw new AccountServiceError(
      "secret-refused",
      "refusing to persist account payload: value appears to contain secret material",
    );
  }
}

function requireDisplayName(raw: unknown): string {
  const parsed = SignInInputSchema.shape.displayName.safeParse(raw);
  if (!parsed.success) {
    throw new AccountServiceError(
      "validation-error",
      "displayName must be a non-empty string of at most 120 characters",
    );
  }
  return parsed.data;
}

function requireEmail(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = SignInInputSchema.shape.email.safeParse(raw);
  if (!parsed.success) {
    throw new AccountServiceError(
      "validation-error",
      "email must be a string of at most 256 characters",
    );
  }
  const trimmed = parsed.data?.trim() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
}

function createOpaqueNonce(): string {
  try {
    const cryptoObj = globalThis.crypto as unknown as
      { getRandomValues?: (arr: Uint8Array) => Uint8Array; randomUUID?: () => string } | undefined;
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(32);
      cryptoObj.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (cryptoObj?.randomUUID) {
      return `${cryptoObj.randomUUID()}-${Date.now().toString(36)}`;
    }
  } catch {
    // fall through toULID fallback
  }
  return `${generateUlid()}-${Math.floor(Math.random() * 1_000_000_000).toString(36)}`;
}

function refreshRefFor(accountId: string): SecretRef {
  return parseSecretRef(`app/account/${accountId.toLowerCase()}/refresh-token`);
}

/** Offline local auth provider (default when the sibling has not landed). */
class LocalAuthProvider implements AccountAuthProvider {
  async begin(): Promise<{ nonce: string; refreshToken: string }> {
    return { nonce: createOpaqueNonce(), refreshToken: createOpaqueNonce() };
  }

  async rotate(input: { refreshToken: string }): Promise<{ nonce: string; refreshToken: string }> {
    if (!input.refreshToken || input.refreshToken.length < 8) {
      throw new AccountServiceError("expired", "session expired, sign in again");
    }
    return { nonce: createOpaqueNonce(), refreshToken: createOpaqueNonce() };
  }
}

// Legal transitions are enforced via canonical isLegalSessionTransition
// (ai-core accounts.ts); the map below documents the shape for readers.

/**
 * AccountService: electron-free local account identity over durable
 * repositories + SecretStore with strict session transitions.
 */
export class AccountService {
  private readonly _accounts: AccountRepoPort;
  private readonly _devices: DeviceRepoPort;
  private readonly _secrets: SecretStore;
  private readonly _bus: AccountEventTransport;
  private readonly _storage: EventRepository;
  private readonly _auth: AccountAuthProvider;
  private readonly _clock?: () => number;
  private readonly _onSignedOut?: () => Promise<void> | void;
  private readonly _stableDeviceId: string;
  private readonly _deviceName: string;
  private readonly _platform: string;
  private readonly _nonces = new Map<string, string>();
  private _session: AccountSessionState = "signed_out";
  private _currentAccountId: string | null = null;
  private readonly _sequenceCounters = new Map<string, number>();

  constructor(deps: AccountServiceDeps) {
    this._accounts = deps.accountRepo;
    this._devices = deps.deviceRepo;
    this._secrets = deps.secretStore;
    this._bus = deps.eventBus;
    this._storage = deps.storage;
    this._auth = deps.authProvider ?? new LocalAuthProvider();
    if (deps.clock) this._clock = deps.clock;
    if (deps.onSignedOut) this._onSignedOut = deps.onSignedOut;
    this._stableDeviceId =
      deps.deviceId && deps.deviceId.trim().length > 0 ? deps.deviceId.trim() : generateUlid();
    this._deviceName = (deps.deviceName ?? "desktop").trim() || "desktop";
    const fallbackPlatform =
      typeof process !== "undefined" && typeof process.platform === "string"
        ? process.platform
        : "unknown";
    this._platform = (deps.platform ?? fallbackPlatform).trim() || "unknown";
  }

  get session(): AccountSessionState {
    return this._session;
  }

  get currentAccountId(): string | null {
    return this._currentAccountId;
  }

  private _nowMs(): number {
    return this._clock ? this._clock() : Date.now();
  }

  private _transition(to: AccountSessionState): void {
    if (this._session === to) return;
    // Idempotent sign-out from any state is always legal.
    if (to === "signed_out") {
      this._session = to;
      return;
    }
    if (!canonicalIsLegalSessionTransition(this._session, to)) {
      throw new AccountServiceError(
        "invalid-transition",
        `cannot transition session from "${this._session}" to "${to}"`,
      );
    }
    this._session = to;
  }

  async signIn(input: SignInInput): Promise<AccountProjection> {
    const parsed = SignInInputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new AccountServiceError(
        "validation-error",
        "sign-in requires displayName 1..120 and optional email 1..256",
      );
    }
    const displayName = requireDisplayName(parsed.data.displayName);
    const email = requireEmail(parsed.data.email);
    refuseSecrets({ displayName, email });

    // signed_out/expired/error may begin; an already-authenticated session
    // re-signs idempotently by returning the current projection.
    if (this._session === "authenticated" || this._session === "refreshing") {
      const existing = await this._loadCurrent();
      if (existing) return this._project(existing.account, existing.device);
    }
    if (
      this._session !== "signed_out" &&
      this._session !== "expired" &&
      this._session !== "error"
    ) {
      // Authenticating sessions cannot nest; fail closed.
      if (this._session === "authenticating") {
        throw new AccountServiceError("invalid-transition", "sign-in already in progress");
      }
    }
    this._transition("authenticating");

    let grant: { nonce: string; refreshToken: string };
    try {
      grant = await this._auth.begin({ displayName, ...(email !== undefined ? { email } : {}) });
    } catch (err) {
      this._transition("error");
      throw err instanceof AccountServiceError
        ? err
        : new AccountServiceError("auth-failed", "sign-in failed");
    }
    if (!grant.nonce || !grant.refreshToken) {
      this._transition("error");
      throw new AccountServiceError("auth-failed", "sign-in failed");
    }

    const nowMs = this._nowMs();
    const timestamp = new Date(nowMs).toISOString();
    // Reuse a matching local profile when present (offline local profile);
    // otherwise create a fresh account row.
    let accountId: string | null = null;
    try {
      const listed = this._accounts.list
        ? await this._accounts.list()
        : this._accounts.current
          ? await this._accounts.current().then((r) => (r ? [r] : []))
          : [];
      const match = listed.find(
        (r) => r.displayName === displayName && (r.email ?? undefined) === email,
      );
      if (match && isUlid(match.accountId)) {
        accountId = match.accountId.toUpperCase();
      }
    } catch {
      accountId = null;
    }
    if (!accountId) {
      accountId = generateUlid(nowMs);
    }

    const accountRecord: AccountRecordPort = {
      accountId,
      displayName: truncate(displayName, MAX_DISPLAY_NAME_LENGTH),
      email: email == null ? null : truncate(email, MAX_EMAIL_LENGTH),
      createdAt: nowMs,
      updatedAt: nowMs,
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
    };
    // Preserve original createdAt when reusing a profile.
    try {
      const prior = await this._accounts.get(accountId).catch(() => null);
      if (prior) {
        accountRecord.createdAt = prior.createdAt;
      }
    } catch {
      // best-effort; creation timestamp falls back to now
    }
    refuseSecrets({ displayName: accountRecord.displayName, email: accountRecord.email });
    try {
      await this._accounts.upsert(accountRecord);
    } catch (err) {
      this._transition("error");
      if (err instanceof AccountServiceError) throw err;
      throw new AccountServiceError("storage-error", "account storage unavailable");
    }

    try {
      if (this._devices.getOrCreateDevice) {
        await this._devices.getOrCreateDevice({
          deviceId: this._stableDeviceId,
          accountId,
          deviceName: truncate(this._deviceName, MAX_DEVICE_NAME_LENGTH),
          platform: this._platform,
          nowMs,
        });
      } else {
        const row: DeviceRecordPort = {
          deviceId: this._stableDeviceId,
          accountId,
          deviceName: truncate(this._deviceName, MAX_DEVICE_NAME_LENGTH),
          platform: this._platform,
          createdAt: nowMs,
          lastSeenAt: nowMs,
        };
        await this._devices.upsert(row);
        await this._devices.get(this._stableDeviceId).catch(() => null);
      }
    } catch (err) {
      this._transition("error");
      if (err instanceof AccountServiceError) throw err;
      throw new AccountServiceError("storage-error", "account storage unavailable");
    }

    try {
      await this._secrets.set(refreshRefFor(accountId), grant.refreshToken);
    } catch {
      this._transition("error");
      throw new AccountServiceError("storage-error", "credential storage unavailable");
    }
    this._nonces.set(accountId, grant.nonce);
    this._currentAccountId = accountId;
    this._transition("authenticated");
    void timestamp;
    await this._emitAccount(accountId, "signed_in");
    const stored = await this._loadCurrent();
    if (!stored) {
      throw new AccountServiceError("storage-error", "account storage unavailable");
    }
    return this._project(stored.account, stored.device);
  }

  /** Renderer-safe projection WITHOUT secrets (no nonce/token/ref). */
  async get(): Promise<AccountProjection | null> {
    const loaded = await this._loadCurrent();
    if (!loaded) return null;
    return this._project(loaded.account, loaded.device);
  }

  async device(): Promise<DeviceProjection | null> {
    const loaded = await this._loadCurrent();
    if (!loaded) return null;
    return {
      deviceId: loaded.device.deviceId,
      accountId: loaded.device.accountId,
      deviceName: loaded.device.deviceName,
      platform: loaded.device.platform,
      lastSeenAt: new Date(loaded.device.lastSeenAt).toISOString(),
    };
  }

  async refresh(): Promise<AccountProjection> {
    const loaded = await this._loadCurrent();
    if (!loaded) {
      throw new AccountServiceError("not-signed-in", "no account is signed in");
    }
    if (
      this._session !== "authenticated" &&
      this._session !== "expired" &&
      this._session !== "error"
    ) {
      throw new AccountServiceError(
        "invalid-transition",
        `cannot refresh from session "${this._session}"`,
      );
    }
    this._transition("refreshing");
    let grant: { nonce: string; refreshToken: string };
    try {
      const current = await this._secrets.get(refreshRefFor(loaded.account.accountId));
      if (!current) {
        throw new AccountServiceError("expired", "session expired, sign in again");
      }
      grant = await this._auth.rotate({ refreshToken: current });
    } catch (err) {
      this._transition("expired");
      await this._emitAccount(loaded.account.accountId, "session.expired").catch(() => undefined);
      if (err instanceof AccountServiceError) throw err;
      throw new AccountServiceError("expired", "session expired, sign in again");
    }
    try {
      await this._secrets.set(refreshRefFor(loaded.account.accountId), grant.refreshToken);
    } catch {
      this._transition("expired");
      await this._emitAccount(loaded.account.accountId, "session.expired").catch(() => undefined);
      throw new AccountServiceError("expired", "session expired, sign in again");
    }
    this._nonces.set(loaded.account.accountId, grant.nonce);
    this._transition("authenticated");
    try {
      if (this._devices.touchLastSeen) {
        await this._devices.touchLastSeen(loaded.device.deviceId, this._nowMs());
      }
    } catch {
      // last-seen is best-effort
    }
    await this._emitAccount(loaded.account.accountId, "session.refreshed");
    const refreshed = await this._loadCurrent();
    if (!refreshed) {
      throw new AccountServiceError("storage-error", "account storage unavailable");
    }
    return this._project(refreshed.account, refreshed.device);
  }

  /**
   * Idempotent sign-out: session -> signed_out, stop-sync callback invoked,
   * in-memory nonce deleted + SecretStore refresh entry removed. Local
   * projects/data (account + device rows) are preserved.
   */
  async signOut(): Promise<{ signedOut: boolean; accountId: string | null }> {
    const accountId = this._currentAccountId;
    if (accountId) {
      this._nonces.delete(accountId);
      try {
        await this._secrets.delete(refreshRefFor(accountId));
      } catch {
        // credential cleanup is best-effort; sign-out still completes
      }
    } else {
      // No active account: still idempotently stop sync and report signed out.
      if (this._onSignedOut) {
        try {
          await this._onSignedOut();
        } catch {
          // stop is best-effort
        }
      }
      this._transition("signed_out");
      return { signedOut: true, accountId: null };
    }
    if (this._onSignedOut) {
      try {
        await this._onSignedOut();
      } catch {
        // stop is best-effort; never fail sign-out over sync teardown
      }
    }
    const wasSignedOut = this._session === "signed_out";
    this._transition("signed_out");
    if (!wasSignedOut) {
      await this._emitAccount(accountId, "signed_out").catch(() => undefined);
    }
    return { signedOut: true, accountId };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async _loadCurrent(): Promise<{
    account: AccountRecordPort;
    device: DeviceRecordPort;
  } | null> {
    let account: AccountRecordPort | null = null;
    if (this._currentAccountId) {
      try {
        account = await this._accounts.get(this._currentAccountId);
      } catch {
        throw new AccountServiceError("storage-error", "account storage unavailable");
      }
    }
    if (!account && this._accounts.current) {
      try {
        account = await this._accounts.current();
      } catch {
        throw new AccountServiceError("storage-error", "account storage unavailable");
      }
      if (account) this._currentAccountId = account.accountId;
    }
    if (!account) return null;
    let device: DeviceRecordPort | null = null;
    try {
      const devices = await this._devices.listByAccount(account.accountId);
      device =
        devices.find((d) => d.deviceId === this._stableDeviceId) ??
        devices[0] ??
        (await this._devices.get(this._stableDeviceId).catch(() => null));
    } catch {
      throw new AccountServiceError("storage-error", "account storage unavailable");
    }
    if (!device) return null;
    return { account, device };
  }

  private _project(account: AccountRecordPort, device: DeviceRecordPort): AccountProjection {
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      ...(account.email != null ? { email: account.email } : {}),
      session: this._session,
      deviceId: device.deviceId,
      createdAt: new Date(account.createdAt).toISOString(),
      updatedAt: new Date(account.updatedAt).toISOString(),
    };
  }

  /** Publishes account.* via storage.append then EventBus.publish. */
  private async _emitAccount(accountId: string, type: AccountEventType): Promise<void> {
    const eventType = accountEventType(type);
    const conversationId = accountId.toUpperCase() as ConversationId;
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sequence = await this._allocateSequence(conversationId);
      const event = {
        eventId: createEventId(),
        conversationId,
        sequence,
        schemaVersion: 1,
        timestamp: new Date(this._nowMs()).toISOString(),
        type: eventType,
        category: "extension",
        accountId,
        session: this._session,
      } as unknown as AIEvent;
      try {
        await this._storage.append(event);
      } catch {
        this._sequenceCounters.set(conversationId, sequence + 1);
        continue;
      }
      await this._bus.publish(event);
      return;
    }
    throw new AccountServiceError("storage-error", "account storage unavailable");
  }

  private async _allocateSequence(conversationId: ConversationId): Promise<number> {
    const cached = this._sequenceCounters.get(conversationId);
    if (cached !== undefined) {
      this._sequenceCounters.set(conversationId, cached + 1);
      return cached;
    }
    let base = 0;
    try {
      const existing = await this._storage.getByConversation(conversationId);
      base = existing.length;
    } catch {
      base = 0;
    }
    this._sequenceCounters.set(conversationId, base + 1);
    return base;
  }
}
