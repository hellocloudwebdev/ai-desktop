// PR45: packages/agent-runtime — Sync Engine Tests (CORE ENGINE layer)
//
// Covers the SyncEngine tick (push -> cursor -> pull -> validate -> merge ->
// apply -> status), failure mapping (offline/auth/retry), safety rails
// (secrets/paths/inert schedules), tombstone propagation, explicit
// conflicts, multi-device convergence via a shared
// InMemoryLoopbackTransport, and start()/stop() idempotence.

import { describe, expect, it } from "vitest";
import {
  createAccountId,
  createDeviceId,
  createSyncRecordId,
  type SyncConflict,
  type SyncRecord,
} from "@ai-desktop/ai-core";
import {
  InMemoryLoopbackTransport,
  type SyncRecord as WireSyncRecord,
} from "../runtime/sync/sync-transport.js";
import {
  SyncEngine,
  SyncEngineError,
  type SyncEngineLocalStore,
} from "../runtime/sync/sync-engine.js";

const T0 = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ACCOUNT = createAccountId();
const DEVICE_A = createDeviceId();
const DEVICE_B = createDeviceId();

function envelope(overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    recordId: createSyncRecordId(),
    entityType: "app.settings",
    entityId: "theme",
    accountId: ACCOUNT,
    deviceId: DEVICE_A,
    version: 1,
    updatedAt: iso(T0),
    payload: { theme: "dark" },
    ...overrides,
  };
}

function tombstone(overrides: Partial<SyncRecord> = {}): SyncRecord {
  const base = envelope(overrides);
  return { ...base, deletedAt: base.updatedAt, payload: null };
}

function wire(overrides: Partial<WireSyncRecord> = {}): WireSyncRecord {
  return {
    accountId: ACCOUNT,
    entityType: "app.settings",
    entityId: "theme",
    version: 1,
    updatedAt: iso(T0),
    deviceId: DEVICE_B,
    payload: { theme: "dark" },
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const entityKey = (r: { entityType: string; entityId: string }): string =>
  `${r.entityType}::${r.entityId}`;

/** In-memory SyncEngineLocalStore: records map + dirty set + conflicts. */
class FakeSyncStore implements SyncEngineLocalStore {
  readonly records = new Map<string, SyncRecord>();
  readonly dirtyKeys = new Set<string>();
  readonly conflicts: SyncConflict[] = [];
  cursor = "";
  markedCleanCount = 0;

  saveLocal(record: SyncRecord): void {
    this.records.set(entityKey(record), clone(record));
    this.dirtyKeys.add(entityKey(record));
  }

  getLocal(entityType: string, entityId: string): SyncRecord | undefined {
    const found = this.records.get(`${entityType}::${entityId}`);
    return found === undefined ? undefined : clone(found);
  }

  async loadDirty(limit: number): Promise<SyncRecord[]> {
    return [...this.dirtyKeys].slice(0, limit).map((k) => clone(this.records.get(k)!));
  }

  async markClean(records: readonly SyncRecord[]): Promise<void> {
    for (const r of records) {
      this.dirtyKeys.delete(entityKey(r));
      this.markedCleanCount += 1;
    }
  }

  async applyRemote(record: SyncRecord): Promise<void> {
    this.records.set(entityKey(record), clone(record));
  }

  async getCursor(): Promise<string> {
    return this.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
  }

  async listConflicts(): Promise<SyncConflict[]> {
    return clone(this.conflicts);
  }

  async saveConflict(conflict: SyncConflict): Promise<void> {
    this.conflicts.push(clone(conflict));
  }
}

function setup(devices = { deviceId: DEVICE_A }, tickMs?: number) {
  const transport = new InMemoryLoopbackTransport();
  const store = new FakeSyncStore();
  let nowMs = T0;
  const engine = new SyncEngine({
    localStore: store,
    transport,
    accountId: ACCOUNT,
    deviceId: devices.deviceId,
    clock: () => nowMs,
    backoffMs: () => 0,
    ...(tickMs !== undefined ? { tickMs } : {}),
  });
  return { transport, store, engine, advance: (ms: number) => (nowMs += ms) };
}

describe("SyncEngine options + idle tick", () => {
  it("rejects empty account/device scope", () => {
    const transport = new InMemoryLoopbackTransport();
    const store = new FakeSyncStore();
    expect(
      () => new SyncEngine({ localStore: store, transport, accountId: "", deviceId: DEVICE_A }),
    ).toThrow(SyncEngineError);
    expect(
      () => new SyncEngine({ localStore: store, transport, accountId: ACCOUNT, deviceId: "  " }),
    ).toThrow(SyncEngineError);
  });

  it("ticks idle with no dirty and no remote", async () => {
    const { store, engine } = setup();
    const summary = await engine.tick();
    expect(summary).toMatchObject({
      pushed: 0,
      pulled: 0,
      applied: 0,
      conflicts: 0,
      invalid: 0,
      refused: 0,
      offline: false,
    });
    expect(engine.getStatus()).toMatchObject({
      state: "idle",
      pendingChanges: 0,
      conflictCount: 0,
    });
    expect(engine.getStatus().lastSyncedAt).toBe(iso(T0));
    expect(store.cursor).toBe("0");
  });
});

describe("SyncEngine push", () => {
  it("pushes dirty envelopes, marks them clean, and advances the cursor", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope());
    const summary = await engine.tick();
    expect(summary.pushed).toBe(1);
    expect(summary.pulled).toBe(0);
    expect(transport.storedCount(ACCOUNT)).toBe(1);
    expect(store.markedCleanCount).toBe(1);
    expect((await store.loadDirty(200)).length).toBe(0);
    expect(store.cursor).not.toBe("");
    expect(engine.getStatus().state).toBe("idle");
  });

  it("refuses secret-shaped outbound payloads (never transmitted, kept dirty)", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ payload: { token: "abc123" } }));
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pushed: 0, refused: 1 });
    expect(transport.storedCount(ACCOUNT)).toBe(0);
    expect(store.markedCleanCount).toBe(0);
    expect((await store.loadDirty(200)).length).toBe(1);
  });

  it("refuses path-bearing project.metadata outbound", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(
      envelope({
        entityType: "project.metadata",
        entityId: "proj-1",
        payload: { projectId: "proj-1", name: "/home/user/proj" },
      }),
    );
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pushed: 0, refused: 1 });
    expect(transport.storedCount(ACCOUNT)).toBe(0);
  });
});

describe("SyncEngine pull validation", () => {
  it("applies valid new remotes", async () => {
    const { transport, store, engine } = setup();
    transport.seedRecords(ACCOUNT, [wire({ payload: { theme: "light" } })]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pulled: 1, applied: 1, invalid: 0 });
    expect(store.getLocal("app.settings", "theme")?.payload).toEqual({ theme: "light" });
  });

  it("rejects non-allowlisted remotes without applying", async () => {
    const { transport, store, engine } = setup();
    transport.seedRecords(ACCOUNT, [
      { ...wire(), entityType: "runs" } as unknown as WireSyncRecord,
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pulled: 1, applied: 0, invalid: 1 });
    expect(store.getLocal("app.settings", "theme")).toBeUndefined();
  });

  it("rejects secret-shaped and path-bearing remotes", async () => {
    const { transport, store, engine } = setup();
    transport.seedRecords(ACCOUNT, [
      wire({ entityId: "s1", payload: { apiKey: "x" } }),
      wire({
        entityId: "p1",
        entityType: "project.metadata",
        payload: { projectId: "p1", name: "C:\\proj" },
      }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pulled: 2, applied: 0, invalid: 2 });
    expect(store.records.size).toBe(0);
  });
});

describe("SyncEngine merge", () => {
  it("auto-merges scalar divergence last-writer-wins (remote newer applies)", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ version: 1, updatedAt: iso(T0) }));
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({ version: 1, updatedAt: iso(T0 + 1_000), payload: { theme: "light" } }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 1, conflicts: 0 });
    expect(store.getLocal("app.settings", "theme")).toMatchObject({
      version: 1,
      payload: { theme: "light" },
    });
  });

  it("keeps local scalar when local wins the triple (no conflict recorded)", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ version: 1, updatedAt: iso(T0 + 5_000) }));
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({ version: 1, updatedAt: iso(T0), payload: { theme: "light" } }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 0, conflicts: 0 });
    expect(store.getLocal("app.settings", "theme")).toMatchObject({
      payload: { theme: "dark" },
    });
  });

  it("applies newer-version remotes over older locals", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ version: 1, updatedAt: iso(T0) }));
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({ version: 2, updatedAt: iso(T0 + 1_000), payload: { theme: "light" } }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 1 });
    expect(store.getLocal("app.settings", "theme")?.version).toBe(2);
  });

  it("records explicit conflicts for schedule.definition divergence (never applies)", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(
      envelope({
        entityType: "schedule.definition",
        entityId: "sched-1",
        payload: { enabled: false, title: "mine" },
      }),
    );
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({
        entityType: "schedule.definition",
        entityId: "sched-1",
        payload: { enabled: false, title: "theirs" },
      }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 0, conflicts: 1 });
    expect(store.getLocal("schedule.definition", "sched-1")).toMatchObject({
      payload: { enabled: false, title: "mine" },
    });
    expect(store.conflicts).toHaveLength(1);
    expect(store.conflicts[0]).toMatchObject({
      entityType: "schedule.definition",
      entityId: "sched-1",
      localVersion: 1,
      remoteVersion: 1,
    });
    expect(store.conflicts[0]?.changedFields.length).toBeGreaterThan(0);
    expect(engine.getStatus()).toMatchObject({ state: "conflict", conflictCount: 1 });
  });

  it("records explicit conflicts for delete-vs-update divergence", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ version: 2, updatedAt: iso(T0) }));
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({ version: 2, updatedAt: iso(T0 + 1_000), deleted: true, payload: {} }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 0, conflicts: 1 });
    // Local update preserved; the conflict carries both versions.
    expect(store.getLocal("app.settings", "theme")).toMatchObject({ version: 2 });
    expect(store.conflicts[0]).toMatchObject({ localVersion: 2, remoteVersion: 2 });
  });

  it("dedupes repeated conflicts across ticks", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope({ version: 2, updatedAt: iso(T0) }));
    await engine.tick();
    transport.seedRecords(ACCOUNT, [
      wire({ version: 2, updatedAt: iso(T0 + 1_000), deleted: true, payload: {} }),
    ]);
    await engine.tick();
    // Second tick re-pulls nothing new (cursor advanced) — force re-merge by
    // resetting the cursor to replay the same remote.
    await store.setCursor("0");
    const summary = await engine.tick();
    expect(summary.conflicts).toBe(1);
    expect(store.conflicts).toHaveLength(1);
  });
});

describe("SyncEngine safety rails", () => {
  it("forces inbound schedule.definition inert (enabled=false, no runs, origin kept)", async () => {
    const { transport, store, engine } = setup();
    transport.seedRecords(ACCOUNT, [
      wire({
        entityType: "schedule.definition",
        entityId: "sched-9",
        deviceId: DEVICE_B,
        payload: { enabled: true, title: "remote", runs: [{ runId: "r1" }] },
      }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 1 });
    const applied = store.getLocal("schedule.definition", "sched-9");
    expect(applied?.payload).toMatchObject({ enabled: false, title: "remote" });
    expect(applied?.payload).not.toHaveProperty("runs");
    expect(applied?.deviceId).toBe(DEVICE_B);
  });

  it("applies extension.metadata verbatim as inert data", async () => {
    const { transport, store, engine } = setup();
    transport.seedRecords(ACCOUNT, [
      wire({
        entityType: "extension.metadata",
        entityId: "ext-1",
        payload: { name: "ext", entrypoint: "main.js" },
      }),
    ]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ applied: 1 });
    expect(store.getLocal("extension.metadata", "ext-1")?.payload).toEqual({
      name: "ext",
      entrypoint: "main.js",
    });
  });
});

describe("SyncEngine tombstones", () => {
  it("pushes tombstones and propagates deletes to a second device", async () => {
    const transport = new InMemoryLoopbackTransport();
    const storeA = new FakeSyncStore();
    const storeB = new FakeSyncStore();
    const noBackoff = () => 0;
    const engineA = new SyncEngine({
      localStore: storeA,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: noBackoff,
    });
    const engineB = new SyncEngine({
      localStore: storeB,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_B,
      clock: () => T0,
      backoffMs: noBackoff,
    });

    storeA.saveLocal(envelope({ version: 1 }));
    await engineA.tick();
    await engineB.tick();
    expect(storeB.getLocal("app.settings", "theme")).toMatchObject({ version: 1 });

    storeA.saveLocal(tombstone({ version: 2, updatedAt: iso(T0 + 1_000) }));
    const pushed = await engineA.tick();
    expect(pushed.pushed).toBe(1);
    expect(pushed.tombstones).toBe(1);

    const pulled = await engineB.tick();
    expect(pulled).toMatchObject({ applied: 1 });
    const deleted = storeB.getLocal("app.settings", "theme");
    expect(deleted?.payload).toBeNull();
    expect(deleted?.deletedAt).toBe(iso(T0 + 1_000));
    expect(pulled.tombstones).toBe(1);
  });
});

describe("SyncEngine multi-device convergence", () => {
  it("two engines converge through a shared transport", async () => {
    const transport = new InMemoryLoopbackTransport();
    const storeA = new FakeSyncStore();
    const storeB = new FakeSyncStore();
    const noBackoff = () => 0;
    const engineA = new SyncEngine({
      localStore: storeA,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: noBackoff,
    });
    const engineB = new SyncEngine({
      localStore: storeB,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_B,
      clock: () => T0,
      backoffMs: noBackoff,
    });

    storeA.saveLocal(
      envelope({ entityId: "theme", payload: { theme: "dark" }, deviceId: DEVICE_A }),
    );
    await engineA.tick();
    await engineB.tick();
    expect(storeB.getLocal("app.settings", "theme")?.payload).toEqual({ theme: "dark" });

    storeB.saveLocal(
      envelope({
        entityId: "theme",
        version: 2,
        updatedAt: iso(T0 + 2_000),
        deviceId: DEVICE_B,
        payload: { theme: "light" },
      }),
    );
    await engineB.tick();
    await engineA.tick();
    expect(storeA.getLocal("app.settings", "theme")).toMatchObject({
      version: 2,
      payload: { theme: "light" },
    });
    expect(storeB.getLocal("app.settings", "theme")).toMatchObject({
      version: 2,
      payload: { theme: "light" },
    });
  });
});

describe("SyncEngine failure mapping", () => {
  it("maps offline push to status offline with the queue retained", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope());
    transport.setFailPush("offline");
    const summary = await engine.tick();
    expect(summary).toMatchObject({ offline: true, error: "offline", pushed: 0 });
    expect(engine.getStatus()).toMatchObject({ state: "offline", pendingChanges: 1 });
    expect((await store.loadDirty(200)).length).toBe(1);
    expect(store.markedCleanCount).toBe(0);
  });

  it("maps auth-expired pull to status error (engine holds no tokens)", async () => {
    const { transport, engine } = setup();
    transport.setFailPull("auth-expired");
    const summary = await engine.tick();
    expect(summary).toMatchObject({ offline: false, error: "auth-expired" });
    expect(engine.getStatus()).toMatchObject({ state: "error", lastError: "auth-expired" });
  });

  it("retries server-error then succeeds within the retry budget", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope());
    transport.scriptPushFailures(["server-error", "server-error"]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pushed: 1, offline: false });
    expect(transport.pushCalls).toBe(3);
    expect(engine.getStatus().state).toBe("idle");
  });

  it("surfaces error after exhausting retries", async () => {
    const { transport, store, engine } = setup();
    store.saveLocal(envelope());
    transport.scriptPushFailures(["server-error", "server-error", "server-error", "server-error"]);
    const summary = await engine.tick();
    expect(summary).toMatchObject({ pushed: 0, error: "push-failed" });
    expect(transport.pushCalls).toBe(4);
    expect(engine.getStatus()).toMatchObject({ state: "error", lastError: "push-failed" });
  });
});

describe("SyncEngine timer", () => {
  it("start()/stop() are idempotent with a single timer", async () => {
    const { transport, store, engine } = setup({ deviceId: DEVICE_A }, 15);
    store.saveLocal(envelope());
    expect(engine.running).toBe(false);
    engine.start();
    engine.start();
    expect(engine.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    engine.stop();
    engine.stop();
    expect(engine.running).toBe(false);
    expect(transport.pushCalls).toBeGreaterThanOrEqual(1);
    const calls = transport.pushCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(transport.pushCalls).toBe(calls);
  });
});
