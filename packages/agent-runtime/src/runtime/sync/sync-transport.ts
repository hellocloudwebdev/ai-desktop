// PR45: packages/agent-runtime — Sync Transport Port + Record Contracts (CORE ENGINE layer)
//
// Pure cross-device sync vocabulary and the injected transport boundary.
//
// Composition rules (mirror background-scheduler.ts):
//   - Structural ports only; this file creates NO timers, launches NO runs, and
//     imports NO scheduler/background managers, Electron, Prisma, fs, network,
//     or child process spawn.
//   - Single timer lives in SyncEngine (sync-engine.ts), not here.
//   - The engine never holds tokens: auth expiry is surfaced as a
//     SyncTransportError with code "auth-expired", never as a credential.
//
// Canonical reconciliation (sibling subagent owns packages/ai-core/src/accounts.ts
// + sync.ts in parallel; DO NOT import them here):
//   - The enums below DUPLICATE the canonical values with identical literals so
//     this package compiles and passes tests whether or not the sibling files
//     have landed. Values MUST match (reconcile on landing):
//       session: signed_out/authenticating/authenticated/refreshing/expired/error
//         (mirrored in runtime/account/account-session-manager.ts)
//       sync:    idle/syncing/offline/error/conflict (mirrored in sync-engine.ts)
//       entity:  account.preferences/workspace.preferences/project.metadata/
//               model.profile/schedule.definition/extension.metadata/app.settings
//       runs:    pending/running/completed/failed/skipped/cancelled and triggers
//               scheduled/manual/recovery are ALREADY canonical in ai-core
//               schedules.ts — runs are NOT a syncable entity and are rejected
//               by the allowlist below.
//   - Validation here is hand-rolled (NO zod import: zod is not a declared
//     dependency of @ai-desktop/agent-runtime and `pnpm architecture:check`
//     forbids undeclared imports). The validators mirror the canonical Zod
//     schemas field-for-field; swap in canonical schemas via the injectable
//     `SyncRecordValidator` hook when the sibling lands.
//   - SECRET_KEY_PATTERN is an exact copy of ai-core background-tasks.ts
//     SECRET_KEYS_PATTERN; keep the two identical on reconciliation.

import type { Brand } from "@ai-desktop/shared";

// ---------------------------------------------------------------------------
// Canonical-mirror enums (see header reconciliation note)
// ---------------------------------------------------------------------------

/** Syncable entity allowlist. Runs/backgroundTaskIds are NOT syncable. */
export const SYNC_ENTITY_TYPES = [
  "account.preferences",
  "workspace.preferences",
  "project.metadata",
  "model.profile",
  "schedule.definition",
  "extension.metadata",
  "app.settings",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export function isSyncEntityType(value: unknown): value is SyncEntityType {
  return typeof value === "string" && (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Bounds (canonical PR45 decisions; do not drift without the sibling)
// ---------------------------------------------------------------------------

/** Maximum serialized payload per record (64 KiB). Larger records are refused. */
export const SYNC_MAX_PAYLOAD_BYTES = 65_536;
/** Maximum dirty records pushed per tick (bounded outbox). */
export const SYNC_MAX_PUSH_PER_TICK = 200;
/** Default pull page size. */
export const SYNC_PULL_LIMIT_DEFAULT = 200;
/** Bounded retention enforced on apply: at most N records per local store. */
export const SYNC_STORE_RETENTION_MAX = 500;
/** Bounded retention enforced on apply: drop records older than N days. */
export const SYNC_STORE_RETENTION_DAYS = 30;
/** Retry ceiling per record (no infinite retry). */
export const SYNC_MAX_ATTEMPTS_DEFAULT = 3;

// ---------------------------------------------------------------------------
// SyncRecord
// ---------------------------------------------------------------------------

/** Branded account scope for sync records (structural; canonical lives in ai-core). */
export type SyncAccountId = Brand<string, "SyncAccountId">;

export interface SyncRecord {
  readonly accountId: string;
  readonly projectId?: string;
  /** Required for project.metadata; part of the scoping key otherwise. */
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  /** Monotonic per entity; starts at 1. */
  readonly version: number;
  /** ISO-8601 timestamp; LWW tie-break after version. */
  readonly updatedAt: string;
  /** Origin device; LWW final tie-break (lexicographic). */
  readonly deviceId: string;
  /** Tombstone delete marker; propagates like any other version. */
  readonly deleted?: boolean;
  /** JSON object payload, <= 64 KiB serialized, never secret-bearing. */
  readonly payload: Record<string, unknown>;
}

/**
 * Scoping key. The engine keys everything by (accountId via engine scope,
 * projectId, entityType, entityId); per-project scoping is preserved because
 * projectId is part of the key.
 */
export function syncRecordKey(record: {
  readonly entityType: string;
  readonly entityId: string;
  readonly projectId?: string;
}): string {
  return `${record.entityType}::${record.projectId ?? "-"}::${record.entityId}`;
}

/** Deep-clones a record so stores/transports never alias caller memory. */
export function cloneSyncRecord(record: SyncRecord): SyncRecord {
  return JSON.parse(JSON.stringify(record)) as SyncRecord;
}

/**
 * LWW comparison over the (version, updatedAt, deviceId) triple.
 * Returns >0 when `a` wins, <0 when `b` wins, 0 when identical.
 */
export function compareSyncTriple(a: SyncRecord, b: SyncRecord): number {
  if (a.version !== b.version) return a.version > b.version ? 1 : -1;
  const aMs = Date.parse(a.updatedAt);
  const bMs = Date.parse(b.updatedAt);
  if (aMs !== bMs) return aMs > bMs ? 1 : -1;
  if (a.deviceId !== b.deviceId) return a.deviceId > b.deviceId ? 1 : -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Validation (hand-rolled mirror of the canonical schemas; see header)
// ---------------------------------------------------------------------------

const DANGEROUS_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ID_LENGTH = 256;

function isSafeId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false;
  if (DANGEROUS_IDS.has(value)) return false;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return false;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export type SyncRecordValidation =
  | { readonly ok: true; readonly record: SyncRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Field-by-field record validation: schema shape, entity allowlist, id rules,
 * version, timestamps, size. Returns a refusal reason instead of throwing so
 * the engine can reject+count invalid records without ever applying them.
 */
export function validateSyncRecordShape(value: unknown): SyncRecordValidation {
  if (!isPlainObject(value)) return { ok: false, reason: "record-must-be-object" };
  const { accountId, projectId, entityType, entityId, version, updatedAt, deviceId, deleted } =
    value;
  if (!isSafeId(accountId)) return { ok: false, reason: "invalid-accountId" };
  if (!isSyncEntityType(entityType)) return { ok: false, reason: "entity-not-allowed" };
  if (!isSafeId(entityId)) return { ok: false, reason: "invalid-entityId" };
  if (projectId !== undefined && !isSafeId(projectId)) {
    return { ok: false, reason: "invalid-projectId" };
  }
  if (entityType === "project.metadata" && projectId === undefined) {
    return { ok: false, reason: "project-metadata-requires-projectId" };
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: "invalid-version" };
  }
  if (typeof updatedAt !== "string" || updatedAt.length > MAX_ID_LENGTH) {
    return { ok: false, reason: "invalid-updatedAt" };
  }
  if (!Number.isFinite(Date.parse(updatedAt))) {
    return { ok: false, reason: "invalid-updatedAt" };
  }
  if (!isSafeId(deviceId)) return { ok: false, reason: "invalid-deviceId" };
  if (deleted !== undefined && typeof deleted !== "boolean") {
    return { ok: false, reason: "invalid-deleted" };
  }
  const payload = (value as { payload?: unknown }).payload;
  if (!isPlainObject(payload)) return { ok: false, reason: "payload-must-be-object" };
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return { ok: false, reason: "payload-not-serializable" };
  }
  if (size > SYNC_MAX_PAYLOAD_BYTES) return { ok: false, reason: "payload-too-large" };
  return {
    ok: true,
    record: {
      accountId,
      ...(projectId !== undefined ? { projectId } : {}),
      entityType,
      entityId,
      version,
      updatedAt,
      deviceId,
      ...(deleted !== undefined ? { deleted } : {}),
      payload: payload as Record<string, unknown>,
    },
  };
}

export function isSyncRecord(value: unknown): value is SyncRecord {
  return validateSyncRecordShape(value).ok;
}

// ---------------------------------------------------------------------------
// Secret guard (local isProbablySecretField mirror; see header)
// ---------------------------------------------------------------------------

/** Exact copy of ai-core SECRET_KEYS_PATTERN — keep identical on reconcile. */
export const SYNC_SECRET_KEY_PATTERN =
  /(api[_-]?key|oauth|token|secret|password|credential|authorization)/i;

const SYNC_SECRET_VALUE_PATTERN =
  /(api[_-]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|passwd\s*[:=]|authorization\s*:\s*bearer|bearer\s+[A-Za-z0-9._~-]{8,}|refresh[_-]?token\s*[:=]|client[_-]?secret\s*[:=]|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

/**
 * True when a payload field looks secret-shaped: the KEY matches the secret
 * pattern, or a string VALUE carries an assignment-style secret / bearer
 * token / PEM block. Mirrors the canonical isProbablySecretField.
 */
export function isProbablySecretField(key: string, value: unknown): boolean {
  if (SYNC_SECRET_KEY_PATTERN.test(key)) return true;
  if (typeof value === "string" && SYNC_SECRET_VALUE_PATTERN.test(value)) return true;
  return false;
}

function scanForSecrets(key: string, value: unknown): boolean {
  if (isProbablySecretField(key, value)) return true;
  if (Array.isArray(value)) {
    return value.some((entry, index) => scanForSecrets(`${key}[${index}]`, entry));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).some(([childKey, childValue]) =>
      scanForSecrets(childKey, childValue),
    );
  }
  return false;
}

/** True when any payload field (recursively) is secret-shaped. */
export function payloadContainsSecrets(payload: Record<string, unknown>): boolean {
  return Object.entries(payload).some(([key, value]) => scanForSecrets(key, value));
}

// ---------------------------------------------------------------------------
// Path guard (project.metadata carries no paths)
// ---------------------------------------------------------------------------

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

/**
 * True when a value looks like a filesystem path: POSIX absolute, home
 * relative, dot-relative, backslash-bearing, Windows drive/UNC, parent-dir
 * refs, or NUL-bearing. Bare `https://` URLs are NOT path-like (they neither
 * start with `/` nor contain backslashes); absolute-style paths are refused.
 */
export function isPathLikeValue(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\0")) return true;
  if (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return true;
  }
  if (value.includes("\\")) return true;
  if (WINDOWS_DRIVE_PATTERN.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  if (value.includes("/../") || value.includes("/./")) return true;
  return false;
}

function scanForPaths(value: unknown): boolean {
  if (typeof value === "string") return isPathLikeValue(value);
  if (Array.isArray(value)) return value.some((entry) => scanForPaths(entry));
  if (isPlainObject(value)) return Object.values(value).some((entry) => scanForPaths(entry));
  return false;
}

/** True when any project.metadata payload value (recursively) looks like a path. */
export function projectPayloadHasPaths(payload: Record<string, unknown>): boolean {
  return scanForPaths(payload);
}

// ---------------------------------------------------------------------------
// Transport port + errors
// ---------------------------------------------------------------------------

export type TransportErrorCode = "offline" | "auth-expired" | "server-error";

/**
 * Transport failure signal. Codes drive engine status mapping:
 * offline -> status offline (queue retained); auth-expired -> status error +
 * needsReauth (engine never holds tokens, so it cannot refresh itself);
 * server-error -> retried, then status error. Messages never carry tokens.
 */
export class SyncTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(`[sync:${code}] ${message}`);
    this.name = "SyncTransportError";
    this.code = code;
  }
}

export interface SyncPushInput {
  readonly accountId: string;
  readonly records: readonly SyncRecord[];
}

export interface SyncPushOutcome {
  /** Opaque server cursor after this push (monotonic per account). */
  readonly cursor: string;
}

export interface SyncPullInput {
  readonly accountId: string;
  /** Opaque cursor from the last push/pull; "" starts from the beginning. */
  readonly cursor: string;
  readonly limit?: number;
}

export interface SyncPullOutcome {
  readonly records: SyncRecord[];
  readonly cursor: string;
}

/** Injected sync backend boundary. Implementations throw SyncTransportError. */
export interface SyncTransport {
  push(input: SyncPushInput): Promise<SyncPushOutcome>;
  pull(input: SyncPullInput): Promise<SyncPullOutcome>;
}

/** Optional canonical-schema hook: prefer canonical validators when available. */
export type SyncRecordValidator = (value: unknown) => SyncRecordValidation;

// ---------------------------------------------------------------------------
// InMemoryLoopbackTransport (shared-instance simulated backend for tests)
// ---------------------------------------------------------------------------

export interface LoopbackTransportHooks {
  /** Simulated latency per call in ms (default 0). */
  latencyMs?: number;
  /** Persistent push failure until cleared. */
  failPush?: TransportErrorCode;
  /** Persistent pull failure until cleared. */
  failPull?: TransportErrorCode;
  /** One-shot scripted push failures (shifted per call). */
  pushFailQueue?: TransportErrorCode[];
  /** One-shot scripted pull failures (shifted per call). */
  pullFailQueue?: TransportErrorCode[];
}

interface LoopbackNamespace {
  records: Map<string, { record: SyncRecord; seq: number }>;
  seq: number;
}

/**
 * In-memory simulated backend. Sharing ONE instance between two engines under
 * one accountId simulates a second device; per-account namespaces keep
 * accounts isolated. Failure-injection hooks simulate offline/auth-expiry for
 * engine tests. Stores clones only (no caller aliasing).
 */
export class InMemoryLoopbackTransport implements SyncTransport {
  private readonly _namespaces = new Map<string, LoopbackNamespace>();
  private readonly _hooks: Required<
    Pick<LoopbackTransportHooks, "latencyMs" | "pushFailQueue" | "pullFailQueue">
  > &
    Pick<LoopbackTransportHooks, "failPush" | "failPull">;
  pushCalls = 0;
  pullCalls = 0;

  constructor(hooks: LoopbackTransportHooks = {}) {
    this._hooks = {
      latencyMs: hooks.latencyMs ?? 0,
      pushFailQueue: [...(hooks.pushFailQueue ?? [])],
      pullFailQueue: [...(hooks.pullFailQueue ?? [])],
      ...(hooks.failPush !== undefined ? { failPush: hooks.failPush } : {}),
      ...(hooks.failPull !== undefined ? { failPull: hooks.failPull } : {}),
    };
  }

  /** Test hook: set/clear a persistent push failure. */
  setFailPush(code: TransportErrorCode | undefined): void {
    if (code === undefined) delete this._hooks.failPush;
    else this._hooks.failPush = code;
  }

  /** Test hook: set/clear a persistent pull failure. */
  setFailPull(code: TransportErrorCode | undefined): void {
    if (code === undefined) delete this._hooks.failPull;
    else this._hooks.failPull = code;
  }

  /** Test hook: queue one-shot failures consumed in order. */
  scriptPushFailures(codes: readonly TransportErrorCode[]): void {
    this._hooks.pushFailQueue.push(...codes);
  }

  /** Test hook: queue one-shot failures consumed in order. */
  scriptPullFailures(codes: readonly TransportErrorCode[]): void {
    this._hooks.pullFailQueue.push(...codes);
  }

  /** Test helper: seed records directly (as if written by another device). */
  seedRecords(accountId: string, records: readonly SyncRecord[]): void {
    const ns = this._ns(accountId);
    for (const record of records) {
      ns.seq += 1;
      ns.records.set(syncRecordKey(record), { record: cloneSyncRecord(record), seq: ns.seq });
    }
  }

  /** Test helper: number of records held for an account. */
  storedCount(accountId: string): number {
    return this._ns(accountId).records.size;
  }

  /** Test helper: current server cursor for an account. */
  serverCursor(accountId: string): string {
    return String(this._ns(accountId).seq);
  }

  /** Test helper: drop everything (fresh backend between suites). */
  clear(): void {
    this._namespaces.clear();
  }

  async push(input: SyncPushInput): Promise<SyncPushOutcome> {
    this.pushCalls += 1;
    await this._latency();
    const queued = this._hooks.pushFailQueue.shift();
    const failure = queued ?? this._hooks.failPush;
    if (failure !== undefined) {
      throw new SyncTransportError(failure, `Simulated push failure (${failure})`);
    }
    if (typeof input.accountId !== "string" || input.accountId.length === 0) {
      throw new SyncTransportError("server-error", "push requires a non-empty accountId");
    }
    const ns = this._ns(input.accountId);
    for (const record of input.records) {
      ns.seq += 1;
      ns.records.set(syncRecordKey(record), { record: cloneSyncRecord(record), seq: ns.seq });
    }
    return { cursor: String(ns.seq) };
  }

  async pull(input: SyncPullInput): Promise<SyncPullOutcome> {
    this.pullCalls += 1;
    await this._latency();
    const queued = this._hooks.pullFailQueue.shift();
    const failure = queued ?? this._hooks.failPull;
    if (failure !== undefined) {
      throw new SyncTransportError(failure, `Simulated pull failure (${failure})`);
    }
    if (typeof input.accountId !== "string" || input.accountId.length === 0) {
      throw new SyncTransportError("server-error", "pull requires a non-empty accountId");
    }
    const since = Number.parseInt(input.cursor, 10);
    const floor = Number.isFinite(since) && since > 0 ? since : 0;
    const limit = input.limit ?? SYNC_PULL_LIMIT_DEFAULT;
    const ns = this._ns(input.accountId);
    const fresh = [...ns.records.values()]
      .filter((entry) => entry.seq > floor)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.max(1, limit));
    const cursor =
      fresh.length > 0 ? String(fresh[fresh.length - 1]?.seq ?? ns.seq) : String(ns.seq);
    return { records: fresh.map((entry) => cloneSyncRecord(entry.record)), cursor };
  }

  private _ns(accountId: string): LoopbackNamespace {
    let ns = this._namespaces.get(accountId);
    if (!ns) {
      ns = { records: new Map(), seq: 0 };
      this._namespaces.set(accountId, ns);
    }
    return ns;
  }

  private async _latency(): Promise<void> {
    if (this._hooks.latencyMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this._hooks.latencyMs);
      });
    }
  }
}
