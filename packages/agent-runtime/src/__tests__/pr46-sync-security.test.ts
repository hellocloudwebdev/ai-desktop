// PR46: packages/agent-runtime — Sync Security (adversarial)
import { describe, expect, it } from "vitest";
import {
  createAccountId,
  createDeviceId,
  createSyncRecordId,
  type SyncConflict,
  type SyncRecord,
} from "@ai-desktop/ai-core";
import { InMemoryLoopbackTransport } from "../runtime/sync/sync-transport.js";
import { SyncEngine, type SyncEngineLocalStore } from "../runtime/sync/sync-engine.js";

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
class FakeStore implements SyncEngineLocalStore {
  readonly records = new Map<string, SyncRecord>();
  readonly dirtyKeys = new Set<string>();
  readonly conflicts: SyncConflict[] = [];
  cursor = "";
  readonly applied: SyncRecord[] = [];
  saveLocal(r: SyncRecord): void {
    this.records.set(`${r.entityType}::${r.entityId}`, JSON.parse(JSON.stringify(r)));
    this.dirtyKeys.add(`${r.entityType}::${r.entityId}`);
  }
  async loadDirty(limit: number): Promise<SyncRecord[]> {
    return [...this.dirtyKeys]
      .slice(0, limit)
      .map((k) => JSON.parse(JSON.stringify(this.records.get(k))));
  }
  async markClean(records: readonly SyncRecord[]): Promise<void> {
    for (const r of records) this.dirtyKeys.delete(`${r.entityType}::${r.entityId}`);
  }
  async applyRemote(record: SyncRecord): Promise<void> {
    this.applied.push(record);
    this.records.set(
      `${record.entityType}::${record.entityId}`,
      JSON.parse(JSON.stringify(record)),
    );
  }
  async getCursor(): Promise<string> {
    return this.cursor;
  }
  async setCursor(c: string): Promise<void> {
    this.cursor = c;
  }
  async listConflicts(): Promise<SyncConflict[]> {
    return [...this.conflicts];
  }
  async saveConflict(c: SyncConflict): Promise<void> {
    this.conflicts.push(c);
  }
}

function engineWith(store: FakeStore, transport = new InMemoryLoopbackTransport()) {
  return new SyncEngine({
    localStore: store,
    transport,
    accountId: ACCOUNT,
    deviceId: DEVICE_A,
    clock: () => T0,
    backoffMs: () => 0,
  });
}

describe("sync security: secret refusal outbound and inbound", () => {
  it("secret-shaped outbound payload refused (never transmitted, stays dirty)", async () => {
    const store = new FakeStore();
    store.saveLocal(envelope({ payload: { api_key: "sk-live-12345678" } as never }));
    const engine = engineWith(store);
    const summary = await engine.tick();
    expect(summary.refused).toBe(1);
    expect(summary.pushed).toBe(0);
    expect((await store.loadDirty(10)).length).toBe(1);
  });
  it("secret-shaped inbound remote rejected (never applied, counted invalid)", async () => {
    const store = new FakeStore();
    const transport = new InMemoryLoopbackTransport();
    transport.seedRecords(ACCOUNT, [
      {
        accountId: ACCOUNT,
        entityType: "app.settings",
        entityId: "evil",
        version: 1,
        updatedAt: iso(T0),
        deviceId: DEVICE_B,
        payload: { password: "hunter99-secret" },
      },
    ]);
    const engine = new SyncEngine({
      localStore: store,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: () => 0,
    });
    const summary = await engine.tick();
    expect(summary.invalid).toBeGreaterThanOrEqual(1);
    expect(store.applied.length).toBe(0);
  });
  it("path-looking project.metadata refused outbound and inbound", async () => {
    const store = new FakeStore();
    store.saveLocal(
      envelope({
        entityType: "project.metadata",
        entityId: "p1",
        payload: { root: "/etc/passwd" } as never,
      }),
    );
    const engine = engineWith(store);
    const summary = await engine.tick();
    expect(summary.refused).toBe(1);
    expect(summary.pushed).toBe(0);
  });
});

describe("sync security: invalid remote, tombstone, extension-inert", () => {
  it("invalid remote envelopes rejected (never applied)", async () => {
    const store = new FakeStore();
    const transport = new InMemoryLoopbackTransport();
    transport.seedRecords(ACCOUNT, [
      {
        accountId: ACCOUNT,
        entityType: "schedule.run",
        entityId: "r1",
        version: 1,
        updatedAt: iso(T0),
        deviceId: DEVICE_B,
        payload: {},
      } as never,
    ]);
    const engine = new SyncEngine({
      localStore: store,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: () => 0,
    });
    const summary = await engine.tick();
    expect(summary.invalid).toBeGreaterThanOrEqual(1);
    expect(store.applied.length).toBe(0);
  });
  it("tombstones propagate versioned deletes (deletedAt + null payload)", async () => {
    const store = new FakeStore();
    const base = envelope();
    store.saveLocal({ ...base, deletedAt: base.updatedAt, payload: null });
    const engine = engineWith(store);
    const summary = await engine.tick();
    expect(summary.pushed).toBe(1);
    expect(summary.tombstones).toBeGreaterThanOrEqual(1);
  });
  it("inbound schedule.definition forced inert (enabled false, runs stripped)", async () => {
    const store = new FakeStore();
    const transport = new InMemoryLoopbackTransport();
    transport.seedRecords(ACCOUNT, [
      {
        accountId: ACCOUNT,
        entityType: "schedule.definition",
        entityId: "sched-1",
        version: 1,
        updatedAt: iso(T0),
        deviceId: DEVICE_B,
        payload: { enabled: true, prompt: "hi", runs: [{ runId: "r" }], executions: [] },
      },
    ]);
    const engine = new SyncEngine({
      localStore: store,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: () => 0,
    });
    await engine.tick();
    expect(store.applied.length).toBe(1);
    const applied = store.applied[0].payload as Record<string, unknown>;
    expect(applied["enabled"]).toBe(false);
    expect("runs" in applied).toBe(false);
    expect("executions" in applied).toBe(false);
  });
  it("extension.metadata applied as inert data (never interpreted)", async () => {
    const store = new FakeStore();
    const transport = new InMemoryLoopbackTransport();
    transport.seedRecords(ACCOUNT, [
      {
        accountId: ACCOUNT,
        entityType: "extension.metadata",
        entityId: "ext-1",
        version: 1,
        updatedAt: iso(T0),
        deviceId: DEVICE_B,
        payload: { hooks: ["onLaunch: rm -rf /"], enabled: true },
      },
    ]);
    const engine = new SyncEngine({
      localStore: store,
      transport,
      accountId: ACCOUNT,
      deviceId: DEVICE_A,
      clock: () => T0,
      backoffMs: () => 0,
    });
    const summary = await engine.tick();
    expect(summary.applied).toBe(1);
    expect(store.applied.length).toBe(1);
  });
});
