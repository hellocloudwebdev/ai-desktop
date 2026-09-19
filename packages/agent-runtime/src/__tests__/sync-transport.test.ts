// PR45: packages/agent-runtime — Sync Transport Tests (CORE ENGINE layer)
//
// Verifies the pre-existing sync-transport.ts boundary: record validation,
// secret/path guards, LWW triple ordering, error codes, and the shared
// InMemoryLoopbackTransport test double (multi-device simulation +
// failure injection).

import { describe, expect, it } from "vitest";
import {
  cloneSyncRecord,
  compareSyncTriple,
  InMemoryLoopbackTransport,
  isPathLikeValue,
  isProbablySecretField,
  isSyncEntityType,
  isSyncRecord,
  payloadContainsSecrets,
  projectPayloadHasPaths,
  SYNC_MAX_PAYLOAD_BYTES,
  syncRecordKey,
  SyncTransportError,
  validateSyncRecordShape,
  type SyncRecord,
} from "../runtime/sync/sync-transport.js";

function validWire(overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    accountId: "acc-1",
    entityType: "app.settings",
    entityId: "theme",
    version: 1,
    updatedAt: new Date(1_000).toISOString(),
    deviceId: "dev-a",
    payload: { theme: "dark" },
    ...overrides,
  };
}

describe("sync-transport record validation", () => {
  it("accepts a well-formed envelope", () => {
    const checked = validateSyncRecordShape(validWire());
    expect(checked.ok).toBe(true);
    expect(isSyncRecord(validWire())).toBe(true);
  });

  it("accepts tombstone-shaped envelopes (deleted flag + empty-ish payload)", () => {
    expect(validateSyncRecordShape(validWire({ deleted: true, payload: {} })).ok).toBe(true);
  });

  it("rejects non-objects and forbidden entity types", () => {
    expect(validateSyncRecordShape(null).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ entityType: "runs" as never })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ entityType: "api.key" as never })).ok).toBe(false);
    expect(isSyncEntityType("runs")).toBe(false);
    expect(isSyncEntityType("app.settings")).toBe(true);
  });

  it("rejects dangerous/oversized ids", () => {
    expect(validateSyncRecordShape(validWire({ entityId: "__proto__" })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ entityId: "" })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ entityId: "x".repeat(257) })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ accountId: "" })).ok).toBe(false);
  });

  it("requires projectId for project.metadata", () => {
    expect(validateSyncRecordShape(validWire({ entityType: "project.metadata" })).ok).toBe(false);
    expect(
      validateSyncRecordShape(validWire({ entityType: "project.metadata", projectId: "proj-1" }))
        .ok,
    ).toBe(true);
  });

  it("rejects bad versions, timestamps, and deleted flags", () => {
    expect(validateSyncRecordShape(validWire({ version: 0 })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ version: 1.5 })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ updatedAt: "not-a-date" })).ok).toBe(false);
    expect(validateSyncRecordShape(validWire({ deleted: "yes" as never })).ok).toBe(false);
  });

  it("rejects non-object, oversized, and unserializable payloads", () => {
    expect(validateSyncRecordShape(validWire({ payload: [] as never })).ok).toBe(false);
    expect(
      validateSyncRecordShape(validWire({ payload: { blob: "x".repeat(SYNC_MAX_PAYLOAD_BYTES) } }))
        .ok,
    ).toBe(false);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(validateSyncRecordShape(validWire({ payload: circular })).ok).toBe(false);
  });

  it("accepts payloads exactly at the size bound", () => {
    const filler = "x".repeat(SYNC_MAX_PAYLOAD_BYTES - 20);
    expect(validateSyncRecordShape(validWire({ payload: { filler } })).ok).toBe(true);
  });
});

describe("sync-transport guards", () => {
  it("flags secret-shaped keys and values", () => {
    expect(isProbablySecretField("apiKey", "x")).toBe(true);
    expect(isProbablySecretField("refresh_token", "x")).toBe(true);
    expect(isProbablySecretField("theme", "dark")).toBe(false);
    expect(isProbablySecretField("notes", "password: hunter2")).toBe(true);
    expect(isProbablySecretField("key", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(payloadContainsSecrets({ theme: "dark" })).toBe(false);
    expect(payloadContainsSecrets({ nested: { oauth: "abc" } })).toBe(true);
    expect(payloadContainsSecrets({ list: [{ token: "abc" }] })).toBe(true);
  });

  it("flags path-looking values", () => {
    expect(isPathLikeValue("/etc/passwd")).toBe(true);
    expect(isPathLikeValue("C:\\Users\\x")).toBe(true);
    expect(isPathLikeValue("../escape")).toBe(true);
    expect(isPathLikeValue("dark")).toBe(false);
    expect(isPathLikeValue("https://example.com/x")).toBe(false);
    expect(projectPayloadHasPaths({ name: "proj" })).toBe(false);
    expect(projectPayloadHasPaths({ nested: { dir: "/tmp/x" } })).toBe(true);
  });
});

describe("sync-transport ordering + keys", () => {
  it("orders by (version, updatedAt, deviceId)", () => {
    const base = validWire();
    expect(compareSyncTriple({ ...base, version: 2 }, { ...base, version: 1 })).toBeGreaterThan(0);
    expect(
      compareSyncTriple(
        { ...base, updatedAt: new Date(2_000).toISOString() },
        { ...base, updatedAt: new Date(1_000).toISOString() },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSyncTriple({ ...base, deviceId: "b" }, { ...base, deviceId: "a" }),
    ).toBeGreaterThan(0);
    expect(compareSyncTriple(base, { ...base })).toBe(0);
  });

  it("scopes keys per project", () => {
    expect(syncRecordKey(validWire())).toBe("app.settings::-::theme");
    expect(syncRecordKey(validWire({ entityType: "project.metadata", projectId: "p1" }))).toBe(
      "project.metadata::p1::theme",
    );
  });

  it("clones without aliasing", () => {
    const original = validWire();
    const clone = cloneSyncRecord(original);
    clone.payload["theme"] = "light";
    expect(original.payload["theme"]).toBe("dark");
  });

  it("carries transport error codes without secret echo", () => {
    const err = new SyncTransportError("auth-expired", "needs reauth");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("auth-expired");
    expect(err.message).toContain("auth-expired");
  });
});

describe("InMemoryLoopbackTransport", () => {
  it("round-trips push/pull with cursor advance", async () => {
    const transport = new InMemoryLoopbackTransport();
    const first = await transport.push({ accountId: "a", records: [validWire()] });
    expect(transport.storedCount("a")).toBe(1);
    expect(transport.serverCursor("a")).toBe(first.cursor);
    const pulled = await transport.pull({ accountId: "a", cursor: "" });
    expect(pulled.records).toHaveLength(1);
    const again = await transport.pull({ accountId: "a", cursor: pulled.cursor });
    expect(again.records).toHaveLength(0);
    expect(transport.pushCalls).toBe(1);
    expect(transport.pullCalls).toBe(2);
  });

  it("isolates accounts and stores clones", async () => {
    const transport = new InMemoryLoopbackTransport();
    const record = validWire();
    await transport.push({ accountId: "a", records: [record] });
    record.payload["theme"] = "mutated";
    const pulled = await transport.pull({ accountId: "a", cursor: "" });
    expect(pulled.records[0]?.payload["theme"]).toBe("dark");
    expect(transport.storedCount("b")).toBe(0);
    const other = await transport.pull({ accountId: "b", cursor: "" });
    expect(other.records).toHaveLength(0);
  });

  it("supports seeded records, limits, and clear", async () => {
    const transport = new InMemoryLoopbackTransport();
    transport.seedRecords("a", [validWire({ entityId: "one" }), validWire({ entityId: "two" })]);
    const limited = await transport.pull({ accountId: "a", cursor: "", limit: 1 });
    expect(limited.records).toHaveLength(1);
    transport.clear();
    expect(transport.storedCount("a")).toBe(0);
  });

  it("injects offline/auth failures persistently and as one-shot scripts", async () => {
    const transport = new InMemoryLoopbackTransport();
    transport.setFailPush("offline");
    await expect(transport.push({ accountId: "a", records: [] })).rejects.toMatchObject({
      code: "offline",
    });
    transport.setFailPush(undefined);
    await expect(transport.push({ accountId: "a", records: [] })).resolves.toMatchObject({
      cursor: expect.any(String),
    });

    transport.scriptPullFailures(["server-error", "auth-expired"]);
    await expect(transport.pull({ accountId: "a", cursor: "" })).rejects.toMatchObject({
      code: "server-error",
    });
    await expect(transport.pull({ accountId: "a", cursor: "" })).rejects.toMatchObject({
      code: "auth-expired",
    });
    await expect(transport.pull({ accountId: "a", cursor: "" })).resolves.toMatchObject({
      records: [],
    });

    transport.setFailPull("offline");
    await expect(transport.pull({ accountId: "a", cursor: "" })).rejects.toMatchObject({
      code: "offline",
    });
    transport.scriptPushFailures(["server-error"]);
    await expect(transport.push({ accountId: "a", records: [] })).rejects.toMatchObject({
      code: "server-error",
    });
  });

  it("rejects empty account ids", async () => {
    const transport = new InMemoryLoopbackTransport();
    await expect(transport.push({ accountId: "", records: [] })).rejects.toMatchObject({
      code: "server-error",
    });
    await expect(transport.pull({ accountId: "", cursor: "" })).rejects.toMatchObject({
      code: "server-error",
    });
  });
});
