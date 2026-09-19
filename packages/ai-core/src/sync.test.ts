// PR45: packages/ai-core — Sync contract unit tests (CONTRACTS layer)

import { describe, expect, it } from "vitest";
import {
  AUTO_MERGEABLE_ENTITY_TYPES,
  EXPLICIT_CONFLICT_ENTITY_TYPES,
  MAX_SYNC_CHANGED_FIELDS,
  MAX_SYNC_ERROR_LENGTH,
  MAX_SYNC_OUTBOX,
  MAX_SYNC_PAYLOAD_BYTES,
  MAX_SYNC_RETRIES,
  MAX_TOMBSTONES,
  SYNC_EVENT_NAMES,
  SYNC_EVENT_TYPES,
  SYNC_TICK_MS_DEFAULT,
  SYNC_ENTITY_TYPES,
  SyncConflictSchema,
  SyncEntityTypeSchema,
  SyncErrorCodeSchema,
  SyncEventNameSchema,
  SyncEventTypeSchema,
  SyncRecordIdSchema,
  SyncConflictIdSchema,
  SyncRecordSchema,
  SyncStateSchema,
  SyncStatusSchema,
  TOMBSTONE_RETENTION_DAYS,
  asSyncConflictId,
  asSyncRecordId,
  buildSyncConflict,
  classifySyncConflict,
  createSyncConflictId,
  createSyncRecordId,
  diffSyncPayloadFields,
  getSyncPayloadBytes,
  isInertScheduleDefinitionPayload,
  isPathLookingValue,
  isProbablySecretField,
  isSyncTombstone,
  isSyncableEntityType,
  parseSyncConflictId,
  parseSyncRecordId,
  resolveScalarConflict,
  syncEventType,
  toSyncError,
  ProjectMetadataSchema,
  type SyncRecord,
} from "./sync.js";
import { createAccountId, createDeviceId } from "./accounts.js";
import { isUlid } from "@ai-desktop/shared";

const TS = "2026-09-18T00:00:00.000Z";
const TS2 = "2026-09-18T01:00:00.000Z";

function makeRecord(overrides: Record<string, unknown> = {}): SyncRecord {
  return SyncRecordSchema.parse({
    recordId: createSyncRecordId(),
    entityType: "account.preferences",
    entityId: "theme",
    accountId: createAccountId(),
    deviceId: createDeviceId(),
    version: 1,
    updatedAt: TS,
    payload: { theme: "dark" },
    ...overrides,
  });
}

describe("sync: branded ids", () => {
  it("generates valid ULIDs distinct across record/conflict namespaces", () => {
    const rid = createSyncRecordId();
    const cid = createSyncConflictId();
    expect(isUlid(rid)).toBe(true);
    expect(isUlid(cid)).toBe(true);
    expect(rid).not.toBe(cid);
    expect(SyncRecordIdSchema.safeParse(rid).success).toBe(true);
    expect(SyncConflictIdSchema.safeParse(cid).success).toBe(true);
    expect(SyncRecordIdSchema.safeParse("short").success).toBe(false);
    expect(SyncConflictIdSchema.safeParse("!!!").success).toBe(false);
  });

  it("parses valid ULIDs and throws TypeError on malformed input", () => {
    const raw = createSyncRecordId().toLowerCase();
    expect(parseSyncRecordId(raw)).toBe(raw.toUpperCase());
    expect(parseSyncConflictId(raw)).toBe(raw.toUpperCase());
    expect(() => parseSyncRecordId("bad-id")).toThrow(TypeError);
    expect(() => parseSyncConflictId("bad-id")).toThrow(TypeError);
    expect(asSyncRecordId("x")).toBe("x");
    expect(asSyncConflictId("y")).toBe("y");
  });
});

describe("sync: entity allowlist (CLOSED)", () => {
  it("accepts exactly the 7 allowlisted entity types", () => {
    expect(SYNC_ENTITY_TYPES).toHaveLength(7);
    for (const t of [
      "account.preferences",
      "workspace.preferences",
      "project.metadata",
      "model.profile",
      "schedule.definition",
      "extension.metadata",
      "app.settings",
    ]) {
      expect(SyncEntityTypeSchema.safeParse(t).success).toBe(true);
      expect(isSyncableEntityType(t)).toBe(true);
    }
  });

  it("rejects every FORBIDDEN category", () => {
    const forbidden = [
      "account.secret",
      "user.token",
      "auth.credential",
      "api.key",
      "user.password",
      "session.cookie",
      "fs.path",
      "source.code",
      "schedule.run",
      "schedule.runs",
      "task.execution",
      "run.history",
      "terminal.session",
      "browser.session",
      "mcp.session",
      "memory.payload",
      "memory.facts",
      "env.vars",
      "environment.variables",
      "secret",
      "token",
      "credential",
      "password",
      "cookie",
      "private_key",
      "",
      "sync.everything",
      "project.files",
    ];
    for (const f of forbidden) {
      expect(isSyncableEntityType(f)).toBe(false);
      expect(SyncEntityTypeSchema.safeParse(f).success).toBe(false);
    }
    expect(isSyncableEntityType(undefined)).toBe(false);
    expect(isSyncableEntityType(null)).toBe(false);
    expect(isSyncableEntityType(42)).toBe(false);
    expect(isSyncableEntityType({})).toBe(false);
  });

  it("splits auto-mergeable vs explicit-conflict entity sets disjointly", () => {
    expect(AUTO_MERGEABLE_ENTITY_TYPES).toHaveLength(5);
    expect(EXPLICIT_CONFLICT_ENTITY_TYPES).toHaveLength(2);
    expect([...EXPLICIT_CONFLICT_ENTITY_TYPES]).toEqual(
      expect.arrayContaining(["schedule.definition", "extension.metadata"]),
    );
    const all = new Set([...AUTO_MERGEABLE_ENTITY_TYPES, ...EXPLICIT_CONFLICT_ENTITY_TYPES]);
    expect(all.size).toBe(7);
    for (const t of SYNC_ENTITY_TYPES) {
      expect(all.has(t as never)).toBe(true);
    }
  });
});

describe("sync: SyncRecord + tombstone", () => {
  it("accepts a minimal valid record", () => {
    const parsed = makeRecord();
    expect(parsed.version).toBe(1);
    expect(parsed.payload).toEqual({ theme: "dark" });
    expect(isSyncTombstone(parsed)).toBe(false);
  });

  it("accepts a tombstone (deletedAt + null payload) and detects it", () => {
    const tomb = makeRecord({ deletedAt: TS2, payload: null });
    expect(isSyncTombstone(tomb)).toBe(true);
    expect(tomb.deletedAt).toBe(TS2);
  });

  it("rejects tombstone-invariant violations", () => {
    // deletedAt without null payload
    expect(
      SyncRecordSchema.safeParse({
        recordId: createSyncRecordId(),
        entityType: "account.preferences",
        entityId: "theme",
        accountId: createAccountId(),
        deviceId: createDeviceId(),
        version: 2,
        updatedAt: TS2,
        deletedAt: TS2,
        payload: { theme: "light" },
      }).success,
    ).toBe(false);
    // null payload without deletedAt
    expect(
      SyncRecordSchema.safeParse({
        recordId: createSyncRecordId(),
        entityType: "account.preferences",
        entityId: "theme",
        accountId: createAccountId(),
        deviceId: createDeviceId(),
        version: 2,
        updatedAt: TS2,
        payload: null,
      }).success,
    ).toBe(false);
  });

  it("rejects bad ids, versions, entityIds, and timestamps", () => {
    expect(() => makeRecord({ recordId: "bad" })).toThrow();
    expect(() => makeRecord({ entityType: "user.token" })).toThrow();
    expect(() => makeRecord({ entityId: "" })).toThrow();
    expect(() => makeRecord({ entityId: "e".repeat(257) })).toThrow();
    expect(() => makeRecord({ version: 0 })).toThrow();
    expect(() => makeRecord({ version: 1.5 })).toThrow();
    expect(() => makeRecord({ updatedAt: "yesterday" })).toThrow();
    expect(() => makeRecord({ accountId: "bad" })).toThrow();
    expect(() => makeRecord({ deviceId: "bad" })).toThrow();
  });

  it("enforces the 65536-byte payload cap", () => {
    expect(MAX_SYNC_PAYLOAD_BYTES).toBe(65536);
    const small = makeRecord({ payload: { a: 1 } });
    expect(getSyncPayloadBytes(small.payload)).toBeLessThanOrEqual(MAX_SYNC_PAYLOAD_BYTES);
    const big = "x".repeat(MAX_SYNC_PAYLOAD_BYTES + 1);
    expect(
      SyncRecordSchema.safeParse({
        recordId: createSyncRecordId(),
        entityType: "account.preferences",
        entityId: "big",
        accountId: createAccountId(),
        deviceId: createDeviceId(),
        version: 1,
        updatedAt: TS,
        payload: { blob: big },
      }).success,
    ).toBe(false);
    // Boundary: payload of exactly the cap parses (small object + padding sized precisely)
    const prefix = JSON.stringify({ blob: "" }).length;
    const pad = "y".repeat(MAX_SYNC_PAYLOAD_BYTES - prefix);
    const boundary = SyncRecordSchema.safeParse({
      recordId: createSyncRecordId(),
      entityType: "account.preferences",
      entityId: "boundary",
      accountId: createAccountId(),
      deviceId: createDeviceId(),
      version: 1,
      updatedAt: TS,
      payload: { blob: pad },
    });
    expect(boundary.success).toBe(true);
  });

  it("rejects non-serializable payloads", () => {
    expect(
      SyncRecordSchema.safeParse({
        recordId: createSyncRecordId(),
        entityType: "account.preferences",
        entityId: "bad",
        accountId: createAccountId(),
        deviceId: createDeviceId(),
        version: 1,
        updatedAt: TS,
        payload: undefined,
      }).success,
    ).toBe(false);
  });

  it("refuses secret-bearing payloads/entityIds with secret-refused", () => {
    const sensitive = "api_key=SUPER-SENSITIVE-SYNC-VALUE";
    const res = SyncRecordSchema.safeParse({
      recordId: createSyncRecordId(),
      entityType: "account.preferences",
      entityId: "theme",
      accountId: createAccountId(),
      deviceId: createDeviceId(),
      version: 1,
      updatedAt: TS,
      payload: { note: `hello ${sensitive}` },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toContain("secret-refused");
      expect(JSON.stringify(res.error)).not.toContain("SUPER-SENSITIVE-SYNC-VALUE");
    }
    expect(() => makeRecord({ payload: { nested: { v: "refresh_token=xyz" } } })).toThrow(
      /secret-refused/,
    );
  });
});

describe("sync: payload bytes + tombstone helpers", () => {
  it("measures JSON bytes (tombstone null is 4 bytes)", () => {
    expect(getSyncPayloadBytes(null)).toBe(4);
    expect(getSyncPayloadBytes({})).toBe(2);
    expect(getSyncPayloadBytes({ a: 1 })).toBeGreaterThan(2);
  });

  it("throws for non-serializable payloads", () => {
    expect(() => getSyncPayloadBytes(undefined)).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => getSyncPayloadBytes(circular)).toThrow();
  });

  it("detects tombstones only when both markers present", () => {
    expect(isSyncTombstone({ deletedAt: TS, payload: null })).toBe(true);
    expect(isSyncTombstone({ payload: null })).toBe(false);
    expect(isSyncTombstone({ deletedAt: TS, payload: {} })).toBe(false);
    expect(isSyncTombstone({})).toBe(false);
  });
});

describe("sync: deterministic conflict ordering (version, updatedAt, deviceId)", () => {
  it("prefers the higher version regardless of timestamps", () => {
    const local = makeRecord({ version: 1, updatedAt: TS2 });
    const remote = makeRecord({
      version: 2,
      updatedAt: TS,
      entityId: local.entityId,
      entityType: local.entityType,
      accountId: local.accountId,
    });
    expect(resolveScalarConflict(local, remote)).toBe(remote);
    expect(resolveScalarConflict(remote, local)).toBe(remote);
  });

  it("breaks version ties by later updatedAt", () => {
    const local = makeRecord({ version: 3, updatedAt: TS });
    const remote = makeRecord({
      version: 3,
      updatedAt: TS2,
      entityId: local.entityId,
      entityType: local.entityType,
      accountId: local.accountId,
    });
    expect(resolveScalarConflict(local, remote)).toBe(remote);
    expect(resolveScalarConflict(remote, local)).toBe(remote);
  });

  it("breaks full ties by ASC-lexicographic deviceId (smaller wins)", () => {
    const accountId = createAccountId();
    const base = {
      recordId: createSyncRecordId(),
      entityType: "account.preferences" as const,
      entityId: "theme",
      accountId,
      version: 5,
      updatedAt: TS,
      payload: { theme: "dark" },
    };
    const deviceA = "AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const deviceB = "BBBBBBBBBBBBBBBBBBBBBBBBBB";
    const recA = SyncRecordSchema.parse({
      ...base,
      recordId: createSyncRecordId(),
      deviceId: deviceA,
    });
    const recB = SyncRecordSchema.parse({
      ...base,
      recordId: createSyncRecordId(),
      deviceId: deviceB,
    });
    expect(resolveScalarConflict(recA, recB)).toBe(recA);
    expect(resolveScalarConflict(recB, recA)).toBe(recA);
  });

  it("is deterministic on complete ties (returns local)", () => {
    const rec = makeRecord();
    expect(resolveScalarConflict(rec, rec)).toBe(rec);
  });
});

describe("sync: classifySyncConflict", () => {
  it("auto-merges scalar prefs/metadata divergences", () => {
    for (const entityType of [
      "account.preferences",
      "workspace.preferences",
      "project.metadata",
      "model.profile",
      "app.settings",
    ]) {
      const local = { entityType, payload: { a: 1 } };
      const remote = { entityType, payload: { a: 2 } };
      expect(classifySyncConflict(local, remote)).toBe("auto-mergeable");
    }
  });

  it("always explicit for schedule.definition + extension.metadata", () => {
    for (const entityType of ["schedule.definition", "extension.metadata"]) {
      expect(
        classifySyncConflict({ entityType, payload: { a: 1 } }, { entityType, payload: { a: 2 } }),
      ).toBe("explicit");
    }
  });

  it("always explicit for any delete-vs-update divergence (even scalar)", () => {
    const live = { entityType: "account.preferences", payload: { theme: "dark" } };
    const tomb = { entityType: "account.preferences", deletedAt: TS2, payload: null };
    expect(classifySyncConflict(live, tomb)).toBe("explicit");
    expect(classifySyncConflict(tomb, live)).toBe("explicit");
    expect(classifySyncConflict(tomb, { ...tomb })).toBe("explicit");
  });
});

describe("sync: diffSyncPayloadFields + buildSyncConflict", () => {
  it("diffs top-level keys only", () => {
    expect(diffSyncPayloadFields({ a: 1, b: 2 }, { a: 1, b: 3 }).sort()).toEqual(["b"]);
    expect(diffSyncPayloadFields({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(diffSyncPayloadFields({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
    expect(diffSyncPayloadFields({ a: 1 }, { a: 1 })).toEqual([]);
    // Nested changes surface as the top-level key only
    expect(diffSyncPayloadFields({ nested: { x: 1 } }, { nested: { x: 2 } })).toEqual(["nested"]);
  });

  it("handles non-object payloads via a synthetic value field", () => {
    expect(diffSyncPayloadFields(1, 1)).toEqual([]);
    expect(diffSyncPayloadFields(1, 2)).toEqual(["value"]);
    expect(diffSyncPayloadFields("a", "b")).toEqual(["value"]);
    expect(diffSyncPayloadFields(null, null)).toEqual([]);
  });

  it("bounds changedFields to 50 entries", () => {
    expect(MAX_SYNC_CHANGED_FIELDS).toBe(50);
    const local: Record<string, number> = {};
    const remote: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      local[`k${i}`] = 1;
      remote[`k${i}`] = 2;
    }
    const diff = diffSyncPayloadFields(local, remote);
    expect(diff).toHaveLength(50);
  });

  it("builds a conflict preserving both versions", () => {
    const local = makeRecord({ version: 2, payload: { theme: "dark", font: 12 } });
    const remote = makeRecord({
      version: 3,
      entityId: local.entityId,
      entityType: local.entityType,
      accountId: local.accountId,
      updatedAt: TS2,
      payload: { theme: "light", font: 12 },
    });
    const conflict = buildSyncConflict({ local, remote, createdAt: TS2 });
    expect(SyncConflictSchema.safeParse(conflict).success).toBe(true);
    expect(isUlid(conflict.conflictId)).toBe(true);
    expect(conflict.entityType).toBe(local.entityType);
    expect(conflict.entityId).toBe(local.entityId);
    expect(conflict.localVersion).toBe(2);
    expect(conflict.remoteVersion).toBe(3);
    expect(conflict.changedFields).toEqual(["theme"]);
    expect(conflict.createdAt).toBe(TS2);
  });

  it("throws when local/remote address different entities", () => {
    const local = makeRecord({ entityId: "a" });
    const remote = makeRecord({ entityId: "b" });
    expect(() => buildSyncConflict({ local, remote })).toThrow();
  });
});

describe("sync: states + status", () => {
  it("accepts exactly the five documented states", () => {
    for (const s of ["idle", "syncing", "offline", "error", "conflict"]) {
      expect(SyncStateSchema.safeParse(s).success).toBe(true);
    }
    for (const bad of ["sync", "pending", "running", "queued", ""]) {
      expect(SyncStateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts a minimal status and optional sync/error fields", () => {
    const parsed = SyncStatusSchema.parse({ state: "idle", pendingChanges: 0, conflictCount: 0 });
    expect(parsed.state).toBe("idle");
    const full = SyncStatusSchema.parse({
      state: "conflict",
      lastSyncedAt: TS,
      pendingChanges: 3,
      lastError: "boom",
      conflictCount: 1,
    });
    expect(full.conflictCount).toBe(1);
  });

  it("rejects negative counters and overlong errors", () => {
    expect(
      SyncStatusSchema.safeParse({ state: "idle", pendingChanges: -1, conflictCount: 0 }).success,
    ).toBe(false);
    expect(
      SyncStatusSchema.safeParse({ state: "idle", pendingChanges: 0, conflictCount: -1 }).success,
    ).toBe(false);
    expect(
      SyncStatusSchema.safeParse({
        state: "error",
        pendingChanges: 0,
        conflictCount: 0,
        lastError: "e".repeat(2001),
      }).success,
    ).toBe(false);
    expect(MAX_SYNC_ERROR_LENGTH).toBe(2000);
  });
});

describe("sync: ProjectMetadata (no filesystem paths)", () => {
  it("accepts minimal and described metadata", () => {
    const parsed = ProjectMetadataSchema.parse({ projectId: "proj-1", name: "Website" });
    expect(parsed.name).toBe("Website");
    expect(parsed.description).toBeUndefined();
    const full = ProjectMetadataSchema.parse({
      projectId: "proj-1",
      name: "Website",
      description: "Marketing site",
    });
    expect(full.description).toBe("Marketing site");
  });

  it("rejects path-looking projectId/name/description", () => {
    for (const bad of [
      { projectId: "/home/user/proj", name: "ok" },
      { projectId: "proj-1", name: "a/b" },
      { projectId: "proj-1", name: "a\\b" },
      { projectId: "C:\\Users\\ada", name: "ok" },
      { projectId: "C:/Users/ada", name: "ok" },
      { projectId: "D:proj", name: "ok" },
      { projectId: "proj-1", name: "ok", description: "see /tmp/notes" },
      { projectId: "proj-1", name: "..\\secret" },
    ]) {
      expect(ProjectMetadataSchema.safeParse(bad).success).toBe(false);
    }
    expect(isPathLookingValue("/a/b")).toBe(true);
    expect(isPathLookingValue("a\\b")).toBe(true);
    expect(isPathLookingValue("C:\\x")).toBe(true);
    expect(isPathLookingValue("C:/x")).toBe(true);
    expect(isPathLookingValue("D:proj")).toBe(true);
    expect(isPathLookingValue("D:")).toBe(true);
    expect(isPathLookingValue("Website")).toBe(false);
    expect(isPathLookingValue("proj-1")).toBe(false);
    expect(isPathLookingValue(42)).toBe(false);
    expect(isPathLookingValue(null)).toBe(false);
  });

  it("rejects empty/overlong fields and secret-bearing text", () => {
    expect(() => ProjectMetadataSchema.parse({ projectId: "", name: "ok" })).toThrow();
    expect(() => ProjectMetadataSchema.parse({ projectId: "p", name: "" })).toThrow();
    expect(() => ProjectMetadataSchema.parse({ projectId: "p", name: "n".repeat(121) })).toThrow();
    expect(() =>
      ProjectMetadataSchema.parse({ projectId: "p", name: "ok", description: "d".repeat(2001) }),
    ).toThrow();
    expect(() => ProjectMetadataSchema.parse({ projectId: "p", name: "api_key=zzz" })).toThrow(
      /secret-refused/,
    );
  });
});

describe("sync: isProbablySecretField", () => {
  it("flags secret-like key names", () => {
    for (const key of [
      "token",
      "access_token",
      "secret",
      "clientSecret",
      "password",
      "user_password",
      "credential",
      "credentials",
      "api_key",
      "api-key",
      "apikey",
      "API_KEY",
      "api key",
      "cookie",
      "session_cookie",
      "private_key",
      "private-key",
      "privatekey",
      "private key",
      "ssh_key",
      "bearer",
      "bearerToken",
      "oauth",
      "oauth_token",
      "refresh",
      "refreshToken",
    ]) {
      expect(isProbablySecretField(key)).toBe(true);
    }
  });

  it("passes ordinary sync keys and non-strings", () => {
    for (const key of ["theme", "fontSize", "displayName", "projectId", "enabled", "timezone"]) {
      expect(isProbablySecretField(key)).toBe(false);
    }
    expect(isProbablySecretField("")).toBe(false);
    expect(isProbablySecretField(undefined)).toBe(false);
    expect(isProbablySecretField(null)).toBe(false);
    expect(isProbablySecretField(42)).toBe(false);
  });
});

describe("sync: inert schedule rule", () => {
  it("treats plain payloads as inert, enabled=true or runs/executions as non-inert", () => {
    expect(isInertScheduleDefinitionPayload({ name: "nightly", hour: 9 })).toBe(true);
    expect(isInertScheduleDefinitionPayload(null)).toBe(true);
    expect(isInertScheduleDefinitionPayload("opaque")).toBe(true);
    expect(isInertScheduleDefinitionPayload({ enabled: true })).toBe(false);
    expect(isInertScheduleDefinitionPayload({ enabled: false })).toBe(true);
    expect(isInertScheduleDefinitionPayload({ runs: [] })).toBe(false);
    expect(isInertScheduleDefinitionPayload({ executions: [] })).toBe(false);
  });
});

describe("sync: error helper", () => {
  it("returns the {code, message} shape and rejects unknown codes", () => {
    expect(toSyncError("offline", "no network")).toEqual({
      code: "offline",
      message: "no network",
    });
    expect(() => toSyncError("nope" as never, "bad")).toThrow();
    for (const code of ["not-found", "validation-error", "secret-refused", "conflict"]) {
      expect(SyncErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

describe("sync: event allowlist", () => {
  it("builds sync.* names for all 5 allowlisted types", () => {
    expect(syncEventType("started")).toBe("sync.started");
    expect(syncEventType("completed")).toBe("sync.completed");
    expect(syncEventType("failed")).toBe("sync.failed");
    expect(syncEventType("conflict")).toBe("sync.conflict");
    expect(syncEventType("queued")).toBe("sync.queued");
    expect(SYNC_EVENT_TYPES).toHaveLength(5);
    expect(SYNC_EVENT_NAMES).toHaveLength(5);
    for (const t of SYNC_EVENT_TYPES) {
      expect(SyncEventTypeSchema.safeParse(t).success).toBe(true);
    }
    for (const n of SYNC_EVENT_NAMES) {
      expect(SyncEventNameSchema.safeParse(n).success).toBe(true);
    }
  });

  it("rejects account-style and ad-hoc types", () => {
    expect(() => syncEventType("created")).toThrow();
    expect(() => syncEventType("account.created")).toThrow();
    expect(() => syncEventType("")).toThrow();
    expect(() => syncEventType("run.started")).toThrow();
  });
});

describe("sync: caps sanity", () => {
  it("keeps sync caps at their canonical values", () => {
    expect(MAX_SYNC_OUTBOX).toBe(200);
    expect(MAX_SYNC_PAYLOAD_BYTES).toBe(65536);
    expect(MAX_TOMBSTONES).toBe(500);
    expect(TOMBSTONE_RETENTION_DAYS).toBe(30);
    expect(MAX_SYNC_RETRIES).toBe(3);
    expect(SYNC_TICK_MS_DEFAULT).toBe(60_000);
    expect(MAX_SYNC_OUTBOX).toBeLessThanOrEqual(MAX_TOMBSTONES);
  });
});
