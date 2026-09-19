// PR45: packages/ai-core — Cross-Device Sync Contracts (CONTRACTS layer)
//
// Pure domain contracts for cross-device sync: the closed syncable-entity
// allowlist, sync records + tombstones, payload caps, deterministic conflict
// ordering + classification + explicit-conflict builder, sync states, the
// syncable project model (no filesystem paths), the inert-schedule rule,
// secret guards, and event names.
//
// Dependency rule:
//   ai-core -> shared (ai-core may ONLY depend on @ai-desktop/shared)
//
// Zero Electron, Prisma, child process spawn, filesystem, or network imports.
// NO runtime logic here: no transporter, no merger writer, no persistence
// writer, no timer. Caps and policies below are enforced by sibling layers,
// never by these schemas.
//
// Canonical PR45 decisions (implemented exactly; do not drift):
//   4. Sync entity allowlist (CLOSED enum — nothing else syncs):
//      account.preferences, workspace.preferences, project.metadata,
//      model.profile, schedule.definition, extension.metadata, app.settings.
//      FORBIDDEN (enforced by isSyncableEntityType + tests): any *secret*,
//      *token*, *credential*, *key*, *password*, *cookie*, filesystem paths
//      as identity, source code, runs/executions, terminal/browser sessions,
//      MCP sessions, memory payloads, environment variables.
//   5. SyncRecord { recordId (branded ULID SyncRecordId), entityType
//      (allowlist enum), entityId (1..256), accountId, deviceId (origin),
//      version (int >=1), updatedAt ISO, deletedAt? (tombstone marker),
//      payload (unknown, <=65536 bytes JSON) }. Tombstone = record with
//      deletedAt set + payload null. Caps: MAX_SYNC_OUTBOX=200,
//      MAX_SYNC_PAYLOAD_BYTES=65536, MAX_TOMBSTONES=500,
//      TOMBSTONE_RETENTION_DAYS=30, MAX_SYNC_RETRIES=3,
//      SYNC_TICK_MS_DEFAULT=60_000.
//   6. Conflict strategy: deterministic ordering by (version DESC,
//      updatedAt DESC, deviceId ASC-lexicographic). Scalar prefs/metadata
//      entity types auto-resolve last-writer-wins via that triple (pure
//      function resolveScalarConflict(local, remote)). UNSAFE-to-automerge
//      entity types schedule.definition + extension.metadata ALWAYS produce
//      explicit conflicts on concurrent divergence; any delete-vs-update
//      divergence ALWAYS produces an explicit conflict. classifySyncConflict
//      returns "auto-mergeable"|"explicit"; buildSyncConflict returns
//      { conflictId, entityType, entityId, localVersion, remoteVersion,
//      changedFields (top-level key diff, bounded 50), createdAt }. Never
//      silently discard: explicit conflicts preserve both versions (callers
//      retain both records; the conflict carries both version numbers).
//   7. Sync states EXACTLY: idle/syncing/offline/error/conflict + SyncStatus
//      { state, lastSyncedAt?, pendingChanges, lastError?, conflictCount }.
//   8. Syncable project model: ProjectMetadata { projectId, name<=120,
//      description?<=2000 } — NO filesystem paths (path-looking values
//      containing / or \ or drive patterns are rejected via guard + tests).
//      Schedule definitions sync WITHOUT runs and WITHOUT enabled=true
//      propagation: synced definitions are inert until locally enabled
//      (canonical requirement; see isInertScheduleDefinitionPayload).
//  10. Secret guard: reuses assertNoSecrets from background-tasks.js in all
//      record validators; isProbablySecretField() helps sibling layers scrub
//      payloads before sync.
//  11. Branded ULID ids follow the identifiers.ts pattern locally (defined
//      here, not in identifiers.ts, to minimize cross-PR conflicts).

import { z } from "zod";
import { TimestampStringSchema, generateUlid, isUlid, type Brand } from "@ai-desktop/shared";
import { assertNoSecrets } from "./background-tasks.js";
import { AccountIdSchema, DeviceIdSchema } from "./accounts.js";

// ---------------------------------------------------------------------------
// Branded Sync Identifiers
//
// Never reuse logical entity IDs across entities. Defined here rather than
// in identifiers.ts to keep this PR's ownership to its own files; the
// pattern mirrors identifiers.ts and schedules.ts.
// ---------------------------------------------------------------------------

export type SyncRecordId = Brand<string, "SyncRecordId">;
export type SyncConflictId = Brand<string, "SyncConflictId">;

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const SyncRecordIdSchema = UlidSchema.transform((val) => val.toUpperCase() as SyncRecordId);
export const SyncConflictIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as SyncConflictId,
);

export function createSyncRecordId(seedTime?: number): SyncRecordId {
  return generateUlid(seedTime) as SyncRecordId;
}

export function createSyncConflictId(seedTime?: number): SyncConflictId {
  return generateUlid(seedTime) as SyncConflictId;
}

export function parseSyncRecordId(raw: string): SyncRecordId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid SyncRecordId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as SyncRecordId;
}

export function parseSyncConflictId(raw: string): SyncConflictId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid SyncConflictId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as SyncConflictId;
}

export function asSyncRecordId(raw: string): SyncRecordId {
  return raw as SyncRecordId;
}

export function asSyncConflictId(raw: string): SyncConflictId {
  return raw as SyncConflictId;
}

// ---------------------------------------------------------------------------
// Sync Entity Allowlist (decision 4: CLOSED enum)
//
// Nothing else syncs. In particular the following are FORBIDDEN and must
// never be added to this enum (enforced by isSyncableEntityType + tests):
//   any *secret*, *token*, *credential*, *key*, *password*, *cookie*,
//   filesystem paths as identity, source code, runs/executions,
//   terminal/browser sessions, MCP sessions, memory payloads,
//   environment variables.
// ---------------------------------------------------------------------------

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

export const SyncEntityTypeSchema = z.enum(SYNC_ENTITY_TYPES);

/**
 * Closed-membership check: true only for the 7 allowlisted entity types.
 * Every forbidden category (secrets, tokens, credentials, keys, passwords,
 * cookies, paths, source code, runs/executions, sessions, MCP sessions,
 * memory payloads, env vars) returns false.
 */
export function isSyncableEntityType(value: unknown): value is SyncEntityType {
  return typeof value === "string" && (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Scalar prefs/metadata types that auto-resolve last-writer-wins. */
export const AUTO_MERGEABLE_ENTITY_TYPES = [
  "account.preferences",
  "workspace.preferences",
  "project.metadata",
  "model.profile",
  "app.settings",
] as const;
export type AutoMergeableEntityType = (typeof AUTO_MERGEABLE_ENTITY_TYPES)[number];

/** UNSAFE-to-automerge types: always explicit on concurrent divergence. */
export const EXPLICIT_CONFLICT_ENTITY_TYPES = [
  "schedule.definition",
  "extension.metadata",
] as const;
export type ExplicitConflictEntityType = (typeof EXPLICIT_CONFLICT_ENTITY_TYPES)[number];

// ---------------------------------------------------------------------------
// Caps (decision 5)
// ---------------------------------------------------------------------------

export const MAX_SYNC_OUTBOX = 200;
export const MAX_SYNC_PAYLOAD_BYTES = 65536;
export const MAX_TOMBSTONES = 500;
export const TOMBSTONE_RETENTION_DAYS = 30;
export const MAX_SYNC_RETRIES = 3;
export const SYNC_TICK_MS_DEFAULT = 60_000;
export const MAX_SYNC_CHANGED_FIELDS = 50;
export const MAX_SYNC_ERROR_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Payload Byte Helper
// ---------------------------------------------------------------------------

/**
 * JSON byte length of a sync payload (UTF-8). Throws when the payload is
 * not JSON-serializable (undefined, function, symbol, bigint, circular).
 */
export function getSyncPayloadBytes(payload: unknown): number {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new TypeError("Sync payload is not JSON-serializable");
  }
  return new TextEncoder().encode(json).length;
}

// ---------------------------------------------------------------------------
// SyncRecord + Tombstone (decision 5)
// ---------------------------------------------------------------------------

export const SyncRecordSchema = z
  .object({
    recordId: SyncRecordIdSchema,
    entityType: SyncEntityTypeSchema,
    entityId: z.string().trim().min(1).max(256),
    accountId: AccountIdSchema,
    deviceId: DeviceIdSchema,
    version: z.number().int().min(1),
    updatedAt: TimestampStringSchema,
    deletedAt: TimestampStringSchema.optional(),
    payload: z.unknown(),
  })
  .superRefine((val, ctx) => {
    const isTombstoneMarker = val.deletedAt !== undefined;
    const isNullPayload = val.payload === null;
    if (isTombstoneMarker !== isNullPayload) {
      ctx.addIssue({
        code: "custom",
        message:
          "Tombstone invariant violated: deletedAt set must pair with payload null (tombstone = deletedAt + null payload)",
        path: ["payload"],
      });
    }
    try {
      const bytes = getSyncPayloadBytes(val.payload);
      if (bytes > MAX_SYNC_PAYLOAD_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `Sync payload exceeds ${MAX_SYNC_PAYLOAD_BYTES} bytes (got ${bytes})`,
          path: ["payload"],
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Sync payload is not JSON-serializable",
        path: ["payload"],
      });
    }
    try {
      assertNoSecrets(val.payload);
      assertNoSecrets(val.entityId);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: sync record appears to contain secret material; store a secure reference instead",
        path: ["payload"],
      });
    }
  });
export type SyncRecord = z.infer<typeof SyncRecordSchema>;

/** Tombstone = record with deletedAt set + payload null. */
export function isSyncTombstone(record: {
  readonly deletedAt?: string;
  readonly payload?: unknown;
}): boolean {
  return record.deletedAt !== undefined && record.payload === null;
}

// ---------------------------------------------------------------------------
// Conflict Strategy (decision 6)
//
// Deterministic ordering by (version DESC, updatedAt DESC, deviceId
// ASC-lexicographic). Scalar prefs/metadata auto-resolve LWW via that
// triple; schedule.definition + extension.metadata + any delete-vs-update
// divergence are always explicit. Never silently discard: explicit
// conflicts preserve both versions (both records must be retained by the
// caller; the conflict below carries both version numbers).
// ---------------------------------------------------------------------------

export const SyncConflictResolutionSchema = z.enum(["auto-mergeable", "explicit"]);
export type SyncConflictResolution = z.infer<typeof SyncConflictResolutionSchema>;

/**
 * Deterministic winner-pick for scalar prefs/metadata: higher version wins;
 * on version tie the later updatedAt wins (ISO-8601 UTC strings compare
 * chronologically); on full tie the lexicographically smaller deviceId
 * wins; on complete tie returns local (stable, deterministic).
 */
export function resolveScalarConflict(local: SyncRecord, remote: SyncRecord): SyncRecord {
  if (remote.version !== local.version) {
    return remote.version > local.version ? remote : local;
  }
  if (remote.updatedAt !== local.updatedAt) {
    return remote.updatedAt > local.updatedAt ? remote : local;
  }
  if (remote.deviceId !== local.deviceId) {
    return remote.deviceId < local.deviceId ? remote : local;
  }
  return local;
}

interface ConflictClassifiable {
  readonly entityType: string;
  readonly deletedAt?: string;
  readonly payload?: unknown;
}

/**
 * Classifies a concurrent divergence. Returns "explicit" when either side
 * is a tombstone (any delete-vs-update divergence is always explicit) or
 * when the entity type is UNSAFE-to-automerge (schedule.definition,
 * extension.metadata); otherwise "auto-mergeable".
 */
export function classifySyncConflict(
  local: ConflictClassifiable,
  remote: ConflictClassifiable,
): SyncConflictResolution {
  const localDeleted = local.deletedAt !== undefined || local.payload === null;
  const remoteDeleted = remote.deletedAt !== undefined || remote.payload === null;
  if (localDeleted || remoteDeleted) {
    return "explicit";
  }
  if (
    (EXPLICIT_CONFLICT_ENTITY_TYPES as readonly string[]).includes(local.entityType) ||
    (EXPLICIT_CONFLICT_ENTITY_TYPES as readonly string[]).includes(remote.entityType)
  ) {
    return "explicit";
  }
  return "auto-mergeable";
}

/**
 * Top-level key diff between two payloads, bounded to 50 entries. Object
 * payloads diff by key (missing keys count as changed); non-object
 * payloads yield ["value"] when serialized forms differ, else [].
 */
export function diffSyncPayloadFields(
  localPayload: unknown,
  remotePayload: unknown,
  maxFields: number = MAX_SYNC_CHANGED_FIELDS,
): string[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isPlainObject(localPayload) && isPlainObject(remotePayload)) {
    const keys = new Set([...Object.keys(localPayload), ...Object.keys(remotePayload)]);
    const changed: string[] = [];
    for (const key of keys) {
      const inLocal = Object.prototype.hasOwnProperty.call(localPayload, key);
      const inRemote = Object.prototype.hasOwnProperty.call(remotePayload, key);
      if (!inLocal || !inRemote) {
        changed.push(key);
      } else {
        let same = false;
        try {
          same = JSON.stringify(localPayload[key]) === JSON.stringify(remotePayload[key]);
        } catch {
          same = false;
        }
        if (!same) changed.push(key);
      }
      if (changed.length >= maxFields) break;
    }
    return changed.slice(0, maxFields);
  }
  try {
    return JSON.stringify(localPayload) === JSON.stringify(remotePayload) ? [] : ["value"];
  } catch {
    return ["value"];
  }
}

export const SyncConflictSchema = z.object({
  conflictId: SyncConflictIdSchema,
  entityType: SyncEntityTypeSchema,
  entityId: z.string().trim().min(1).max(256),
  localVersion: z.number().int().min(1),
  remoteVersion: z.number().int().min(1),
  changedFields: z.array(z.string().trim().min(1).max(256)).max(MAX_SYNC_CHANGED_FIELDS),
  createdAt: TimestampStringSchema,
});
export type SyncConflict = z.infer<typeof SyncConflictSchema>;

/**
 * Builds an explicit conflict record preserving both versions (never
 * silently discards either side). Requires both records to address the
 * same entityType/entityId; throws otherwise.
 */
export function buildSyncConflict(args: {
  readonly local: SyncRecord;
  readonly remote: SyncRecord;
  readonly createdAt?: string;
}): SyncConflict {
  const { local, remote } = args;
  if (local.entityType !== remote.entityType || local.entityId !== remote.entityId) {
    throw new Error("buildSyncConflict requires local and remote to address the same entity");
  }
  const createdAt = args.createdAt ?? new Date().toISOString();
  return SyncConflictSchema.parse({
    conflictId: createSyncConflictId(),
    entityType: local.entityType,
    entityId: local.entityId,
    localVersion: local.version,
    remoteVersion: remote.version,
    changedFields: diffSyncPayloadFields(local.payload, remote.payload),
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// Sync States (decision 7)
// ---------------------------------------------------------------------------

export const SyncStateSchema = z.enum(["idle", "syncing", "offline", "error", "conflict"]);
export type SyncState = z.infer<typeof SyncStateSchema>;

export const SyncStatusSchema = z.object({
  state: SyncStateSchema,
  lastSyncedAt: TimestampStringSchema.optional(),
  pendingChanges: z.number().int().min(0),
  lastError: z.string().max(MAX_SYNC_ERROR_LENGTH).optional(),
  conflictCount: z.number().int().min(0),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

// ---------------------------------------------------------------------------
// Syncable Project Model (decision 8: NO filesystem paths)
// ---------------------------------------------------------------------------

/**
 * True for path-looking values: contains "/" or "\" or matches a Windows
 * drive pattern (e.g. "C:\\", "C:/", "D:", "D:proj"). Syncable metadata
 * carries opaque ids + display names only, never filesystem paths.
 */
export function isPathLookingValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.includes("/") || value.includes("\\")) return true;
  if (/^[A-Za-z]:/.test(value.trim())) return true;
  return false;
}

export const ProjectMetadataSchema = z
  .object({
    projectId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    const fields = [
      ["projectId", val.projectId],
      ["name", val.name],
      ...(val.description !== undefined ? [["description", val.description] as const] : []),
    ] as const;
    for (const [key, fieldValue] of fields) {
      if (isPathLookingValue(fieldValue)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} must not be a filesystem path`,
          path: [key],
        });
      }
    }
    try {
      assertNoSecrets(val.projectId);
      assertNoSecrets(val.name);
      if (val.description !== undefined) assertNoSecrets(val.description);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: project metadata appears to contain secret material; store a secure reference instead",
        path: ["name"],
      });
    }
  });
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

// ---------------------------------------------------------------------------
// Inert Schedule Rule (decision 8)
//
// Synced schedule.definition records MUST NOT carry runs and MUST NOT
// propagate enabled=true. A synced definition is inert until locally
// enabled by the user on the receiving device; schedule existence is
// never a permission grant and never auto-starts execution.
// ---------------------------------------------------------------------------

/**
 * Sibling-layer guard for the canonical inert-schedule requirement:
 * returns false when a schedule.definition payload carries enabled=true
 * or a runs/executions key (both must be stripped before sync).
 */
export function isInertScheduleDefinitionPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return true;
  }
  const record = payload as Record<string, unknown>;
  if (record["enabled"] === true) return false;
  if ("runs" in record || "executions" in record) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Secret-Field Helper (decision 10)
//
// Sibling layers call this to scrub sync payloads BEFORE sync: any object
// key returning true must be replaced with a secure reference, never
// synced raw.
// ---------------------------------------------------------------------------

const SECRET_FIELD_PATTERN =
  /(token|secret|password|credential|api[ _-]?key|cookie|private[ _-]?key|ssh|bearer|oauth|refresh)/i;

export function isProbablySecretField(key: unknown): boolean {
  return typeof key === "string" && SECRET_FIELD_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Error Taxonomy
// ---------------------------------------------------------------------------

export const SyncErrorCodeSchema = z.enum([
  "not-found",
  "validation-error",
  "secret-refused",
  "conflict",
  "offline",
  "storage-error",
]);
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;

export interface SyncError {
  readonly code: SyncErrorCode;
  readonly message: string;
}

export function toSyncError(code: SyncErrorCode, message: string): SyncError {
  return { code: SyncErrorCodeSchema.parse(code), message };
}

// ---------------------------------------------------------------------------
// Sync Event Names
//
// Full event names: sync.started, sync.completed, sync.failed,
// sync.conflict, sync.queued. Events carry ids + status/detail only,
// NEVER tokens or payload bytes.
// ---------------------------------------------------------------------------

export const SYNC_EVENT_TYPES = ["started", "completed", "failed", "conflict", "queued"] as const;
export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

export const SyncEventTypeSchema = z.enum(SYNC_EVENT_TYPES);

export const SYNC_EVENT_NAMES = [
  "sync.started",
  "sync.completed",
  "sync.failed",
  "sync.conflict",
  "sync.queued",
] as const;
export type SyncEventName = (typeof SYNC_EVENT_NAMES)[number];

export const SyncEventNameSchema = z.enum(SYNC_EVENT_NAMES);

/**
 * Builds a `sync.<type>` event name, rejecting anything outside the
 * allowlist so producers cannot invent ad-hoc event types. Mirrors
 * backgroundEventType/scheduleEventType.
 */
export function syncEventType(type: string): `sync.${SyncEventType}` {
  if (!(SYNC_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid sync event type: "${type}"`);
  }
  return `sync.${type as SyncEventType}`;
}
