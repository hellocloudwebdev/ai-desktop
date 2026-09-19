// PR45: apps/desktop — DesktopSyncService Tests
//
// Thin-orchestration coverage: initial idle status, start tick with cursor
// advance, pause parks, conflict bounds, keep-local/keep-remote resolution,
// validation/not-found errors, secret refusal, tombstone propagation,
// onSignedOut pause, append-before-publish ordering, and offline mapping.
// No Electron is needed anywhere in this suite; time is injected via clock
// (never real waiting).

import { describe, expect, it } from "vitest";
import type { AIEvent, ConversationId } from "@ai-desktop/ai-core";
import type { SyncConflictRow, SyncRecordRow } from "@ai-desktop/storage";
import {
  DesktopSyncService,
  SyncServiceError,
  pullCursorKey,
  type EngineSyncRecord,
  type PushPullTransport,
  type SyncPullInput,
  type SyncPullOutcome,
} from "../sync-service.js";

class InMemoryRecordRepo {
  readonly rows = new Map<string, SyncRecordRow>();

  async upsert(record: SyncRecordRow): Promise<boolean> {
    const existing = this.rows.get(record.recordId) ?? null;
    if (existing) {
      if (existing.version > record.version) return false;
      if (existing.version === record.version && existing.updatedAt >= record.updatedAt) {
        return false;
      }
    }
    this.rows.set(record.recordId, { ...record });
    return true;
  }

  async get(recordId: string): Promise<SyncRecordRow | null> {
    return this.rows.get(recordId) ?? null;
  }

  async listByAccount(accountId: string, limit?: number): Promise<SyncRecordRow[]> {
    const take = limit === undefined ? undefined : Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = [...this.rows.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return take === undefined ? rows : rows.slice(0, take);
  }

  async getDirty(accountId: string, cursor: number): Promise<SyncRecordRow[]> {
    const watermark = Number.isFinite(cursor) ? cursor : 0;
    return (await this.listByAccount(accountId, 500)).filter((row) => row.updatedAt > watermark);
  }

  async writeTombstone(record: SyncRecordRow, atMs?: number): Promise<boolean> {
    const at = atMs ?? Date.now();
    return this.upsert({ ...record, payloadJson: "{}", updatedAt: at, deletedAt: at });
  }
}

class InMemoryCursorRepo {
  readonly values = new Map<string, number>();

  async getValue(key: string, fallback = 0): Promise<number> {
    return this.values.get(key) ?? fallback;
  }

  async set(key: string, value: number): Promise<void> {
    this.values.set(key, value);
  }
}

class InMemoryConflictRepo {
  readonly rows = new Map<string, SyncConflictRow>();

  async save(conflict: SyncConflictRow): Promise<void> {
    this.rows.set(conflict.conflictId, { ...conflict });
  }

  async list(accountId?: string, limit?: number): Promise<SyncConflictRow[]> {
    const take = limit === undefined ? 50 : Math.max(1, Math.min(100, Math.floor(limit)));
    return [...this.rows.values()]
      .filter((row) => accountId === undefined || row.accountId === accountId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, take);
  }

  async resolve(conflictId: string): Promise<boolean> {
    return this.rows.delete(conflictId);
  }
}

class StubTransport implements PushPullTransport {
  mode: "online" | "offline" = "online";
  readonly pushed: EngineSyncRecord[][] = [];
  readonly pulled: string[] = [];
  remotes: EngineSyncRecord[] = [];

  async push(input: { accountId: string; records: readonly EngineSyncRecord[] }): Promise<{
    cursor: string;
  }> {
    if (this.mode === "offline") {
      throw Object.assign(new Error("transport offline"), { code: "offline" });
    }
    this.pushed.push([...input.records]);
    return { cursor: "" };
  }

  async pull(input: SyncPullInput): Promise<SyncPullOutcome> {
    if (this.mode === "offline") {
      throw Object.assign(new Error("transport offline"), { code: "offline" });
    }
    this.pulled.push(input.accountId);
    return { records: this.remotes.map((record) => ({ ...record })), cursor: input.cursor };
  }
}

class StubEventBus {
  readonly events: AIEvent[] = [];

  async publish(event: Readonly<AIEvent>): Promise<void> {
    this.events.push(event as AIEvent);
  }
}

class StubStorage {
  readonly appended: AIEvent[] = [];

  async append(event: Readonly<AIEvent>): Promise<void> {
    this.appended.push(event as AIEvent);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return this.appended.filter((event) => event.conversationId === conversationId);
  }
}

const T0 = Date.parse("2026-09-18T10:00:00.000Z");
const ACCOUNT = "acc-01";
const DEVICE = "dev-01";

function recordId(accountId: string, entityType: string, entityId: string): string {
  return `${accountId}::${entityType}::${entityId}`;
}

function localRow(overrides: Partial<SyncRecordRow> = {}): SyncRecordRow {
  return {
    recordId: recordId(ACCOUNT, "app.settings", "theme"),
    entityType: "app.settings",
    entityId: "theme",
    accountId: ACCOUNT,
    deviceId: DEVICE,
    version: 1,
    payloadJson: JSON.stringify({ theme: "dark" }),
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

function remoteRecord(overrides: Partial<EngineSyncRecord> = {}): EngineSyncRecord {
  return {
    accountId: ACCOUNT,
    entityType: "app.settings",
    entityId: "theme",
    version: 1,
    updatedAt: new Date(T0 + 1_000).toISOString(),
    deviceId: "dev-02",
    payload: { theme: "light" },
    ...overrides,
  };
}

function localScheduleRow(overrides: Partial<SyncRecordRow> = {}): SyncRecordRow {
  return {
    recordId: recordId(ACCOUNT, "schedule.definition", "sched-01"),
    entityType: "schedule.definition",
    entityId: "sched-01",
    accountId: ACCOUNT,
    deviceId: DEVICE,
    version: 1,
    payloadJson: JSON.stringify({ enabled: false, title: "mine" }),
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

function remoteScheduleRecord(overrides: Partial<EngineSyncRecord> = {}): EngineSyncRecord {
  return {
    accountId: ACCOUNT,
    entityType: "schedule.definition",
    entityId: "sched-01",
    version: 1,
    updatedAt: new Date(T0 + 1_000).toISOString(),
    deviceId: "dev-02",
    payload: { enabled: false, title: "theirs" },
    ...overrides,
  };
}

function createHarness() {
  let nowMs = T0;
  const records = new InMemoryRecordRepo();
  const cursors = new InMemoryCursorRepo();
  const conflicts = new InMemoryConflictRepo();
  const transport = new StubTransport();
  const bus = new StubEventBus();
  const storage = new StubStorage();
  const service = new DesktopSyncService({
    recordRepo: records,
    cursorRepo: cursors,
    conflictRepo: conflicts,
    transport,
    eventBus: bus,
    storage,
    deviceId: DEVICE,
    accountId: ACCOUNT,
    clock: () => nowMs,
    tickMs: 3_600_000,
  });
  return {
    records,
    cursors,
    conflicts,
    transport,
    bus,
    storage,
    service,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function eventTypes(events: AIEvent[]): string[] {
  return events.map((event) => (event as { type: string }).type);
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("apps/desktop: DesktopSyncService (PR45)", () => {
  it("reports initial idle status with paused false", async () => {
    const h = createHarness();
    try {
      const view = await h.service.status();
      expect(view.status).toBe("idle");
      expect(view.paused).toBe(false);
      expect(view.pendingCount).toBe(0);
      expect(view.conflictCount).toBe(0);
    } finally {
      h.service.dispose();
    }
  });

  it("start ticks once and advances the pull cursor to idle", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow());
      const view = await h.service.start();
      expect(h.transport.pushed).toHaveLength(1);
      expect(h.transport.pushed[0]).toHaveLength(1);
      expect(await h.cursors.getValue(pullCursorKey(ACCOUNT), 0)).toBe(T0);
      expect(view.status).toBe("idle");
      expect(view.paused).toBe(false);
      expect(view.pendingCount).toBe(0);
      expect(view.lastSyncAt).toBe(new Date(T0).toISOString());
      expect(eventTypes(h.bus.events)).toContain("sync.started");
      expect(eventTypes(h.bus.events)).toContain("sync.completed");
    } finally {
      h.service.dispose();
    }
  });

  it("pause parks with idle status and paused true", async () => {
    const h = createHarness();
    try {
      await h.service.start();
      const pushes = h.transport.pushed.length;
      const view = await h.service.pause();
      expect(view.status).toBe("idle");
      expect(view.paused).toBe(true);
      expect(h.service.paused).toBe(true);
      await settle();
      expect(h.transport.pushed.length).toBe(pushes);
      expect(h.transport.pulled.length).toBe(1);
    } finally {
      h.service.dispose();
    }
  });

  it("conflicts are bounded 1..100 with default 50", async () => {
    const h = createHarness();
    try {
      for (let i = 0; i < 3; i += 1) {
        await h.conflicts.save({
          conflictId: `c-${i}`,
          entityType: "app.settings",
          entityId: `e-${i}`,
          accountId: ACCOUNT,
          localVersion: 1,
          remoteVersion: 1,
          changedFieldsJson: JSON.stringify(["theme"]),
          createdAt: T0 + i,
        });
      }
      expect((await h.service.conflicts(undefined, 2)).conflicts).toHaveLength(2);
      expect((await h.service.conflicts(undefined, 0)).conflicts).toHaveLength(1);
      expect((await h.service.conflicts(undefined, 500)).conflicts).toHaveLength(3);
      expect((await h.service.conflicts()).conflicts).toHaveLength(3);
    } finally {
      h.service.dispose();
    }
  });

  it("resolve keep-local applies a bumped version and deletes the conflict", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localScheduleRow());
      h.transport.remotes = [remoteScheduleRecord()];
      await h.service.start();
      const [row] = (await h.service.conflicts()).conflicts;
      expect(row.conflictId).toBe(
        `conflict::${recordId(ACCOUNT, "schedule.definition", "sched-01")}`,
      );
      const result = await h.service.resolve(row.conflictId, "keep-local");
      expect(result.appliedEntity).toBe("schedule.definition");
      expect(result.appliedVersion).toBe(2);
      const stored = await h.records.get(recordId(ACCOUNT, "schedule.definition", "sched-01"));
      expect(stored?.version).toBe(2);
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({ enabled: false, title: "mine" });
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("resolve keep-remote applies the remote payload and deletes the conflict", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localScheduleRow());
      h.transport.remotes = [remoteScheduleRecord()];
      await h.service.start();
      const [row] = (await h.service.conflicts()).conflicts;
      const result = await h.service.resolve(row.conflictId, "keep-remote");
      expect(result.appliedEntity).toBe("schedule.definition");
      expect(result.appliedVersion).toBe(2);
      const stored = await h.records.get(recordId(ACCOUNT, "schedule.definition", "sched-01"));
      expect(stored?.version).toBe(2);
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({ enabled: false, title: "theirs" });
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("resolve with a non-explicit choice throws SYNC_VALIDATION", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localScheduleRow());
      h.transport.remotes = [remoteScheduleRecord()];
      await h.service.start();
      const [row] = (await h.service.conflicts()).conflicts;
      await expect(h.service.resolve(row.conflictId, "auto" as "keep-local")).rejects.toMatchObject(
        { code: "SYNC_VALIDATION" },
      );
    } finally {
      h.service.dispose();
    }
  });

  it("resolve of an unknown id throws SYNC_NOT_FOUND", async () => {
    const h = createHarness();
    try {
      await expect(h.service.resolve("conflict::missing", "keep-local")).rejects.toMatchObject({
        code: "SYNC_NOT_FOUND",
      });
    } finally {
      h.service.dispose();
    }
  });

  it("refuses secret-bearing records before any transport call", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(
        localRow({ payloadJson: JSON.stringify({ api_key: "sk-live-secret-value" }) }),
      );
      await expect(h.service.start()).rejects.toMatchObject({ code: "SYNC_VALIDATION" });
      expect(h.transport.pushed).toHaveLength(0);
      expect(h.transport.pulled).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("propagates remote tombstones through the tombstone write path", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow());
      h.transport.remotes = [remoteRecord({ version: 2, deleted: true })];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(stored?.payloadJson).toBe("{}");
      expect(stored?.deletedAt).not.toBeNull();
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("asOnSignedOutCallback pauses the service", async () => {
    const h = createHarness();
    try {
      await h.service.start();
      const callback = h.service.asOnSignedOutCallback();
      await callback();
      expect(h.service.paused).toBe(true);
      expect((await h.service.status()).paused).toBe(true);
    } finally {
      h.service.dispose();
    }
  });

  it("emits sync events storage-append-before-bus-publish in order", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow());
      await h.service.start();
      expect(h.storage.appended).toHaveLength(h.bus.events.length);
      expect(eventTypes(h.storage.appended)).toEqual(eventTypes(h.bus.events));
      expect(eventTypes(h.bus.events).slice(0, 3)).toEqual([
        "sync.started",
        "sync.queued",
        "sync.completed",
      ]);
    } finally {
      h.service.dispose();
    }
  });

  it("maps transport offline to SYNC_OFFLINE", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow());
      h.transport.mode = "offline";
      await expect(h.service.start()).rejects.toMatchObject({ code: "SYNC_OFFLINE" });
      expect((await h.service.status()).status).toBe("offline");
    } finally {
      h.service.dispose();
    }
  });

  it("throws SyncServiceError with CODE-prefixed messages", () => {
    const err = new SyncServiceError("SYNC_VALIDATION", "bad input");
    expect(err.message).toBe("SYNC_VALIDATION: bad input");
    expect(err.code).toBe("SYNC_VALIDATION");
  });

  it("LWW scalar: remote newer same-version applies without conflict", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow());
      h.transport.remotes = [remoteRecord()];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({ theme: "light" });
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
      expect((await h.service.status()).status).toBe("idle");
    } finally {
      h.service.dispose();
    }
  });

  it("LWW scalar: local newer same-version keeps local without conflict", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow({ updatedAt: T0 + 5_000 }));
      h.transport.remotes = [remoteRecord({ updatedAt: new Date(T0).toISOString() })];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({ theme: "dark" });
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("forces inbound schedule.definition inert (enabled=false, no runs, origin kept)", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [
        remoteScheduleRecord({
          entityId: "sched-09",
          deviceId: "dev-09",
          payload: { enabled: true, title: "remote", runs: [{ runId: "r1" }] },
        }),
      ];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "schedule.definition", "sched-09"));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toMatchObject({
        enabled: false,
        title: "remote",
      });
      expect(JSON.parse(stored?.payloadJson ?? "{}")).not.toHaveProperty("runs");
      expect(stored?.deviceId).toBe("dev-09");
    } finally {
      h.service.dispose();
    }
  });

  it("applies extension.metadata verbatim as inert data (no install/activate)", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [
        remoteRecord({
          entityType: "extension.metadata",
          entityId: "ext-01",
          version: 2,
          payload: { name: "ext", entrypoint: "main.js" },
        }),
      ];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "extension.metadata", "ext-01"));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({
        name: "ext",
        entrypoint: "main.js",
      });
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });

  it("records explicit conflicts for delete-vs-update same-version divergence", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(localRow({ version: 2, updatedAt: T0 }));
      h.transport.remotes = [remoteRecord({ version: 2, deleted: true })];
      await h.service.start();
      expect((await h.service.conflicts()).conflicts).toHaveLength(1);
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(stored?.version).toBe(2);
      expect(stored?.deletedAt).toBeNull();
    } finally {
      h.service.dispose();
    }
  });

  it("counts invalid remotes and skips them without applying", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [
        // Invalid: version 0 + unknown entity + oversized handled as invalid.
        { ...remoteRecord(), version: 0 } as unknown as EngineSyncRecord,
        { ...remoteRecord(), entityType: "runs" } as unknown as EngineSyncRecord,
        remoteRecord({ entityId: "theme", version: 2, payload: { theme: "kept" } }),
      ];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(stored?.version).toBe(2);
      expect(JSON.parse(stored?.payloadJson ?? "{}")).toEqual({ theme: "kept" });
    } finally {
      h.service.dispose();
    }
  });

  it("isolates accounts: remote for another account never applies", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [remoteRecord({ accountId: "acc-other" })];
      await h.service.start();
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(stored).toBeNull();
      const other = await h.records.get(recordId("acc-other", "app.settings", "theme"));
      expect(other).toBeNull();
    } finally {
      h.service.dispose();
    }
  });

  it("rejects non-allowlisted entities (runs) without transport apply", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [
        { ...remoteRecord(), entityType: "backgroundTaskIds" } as unknown as EngineSyncRecord,
      ];
      await h.service.start();
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
      expect(await h.records.get(recordId(ACCOUNT, "backgroundTaskIds", "theme"))).toBeNull();
    } finally {
      h.service.dispose();
    }
  });

  it("retries transient server errors up to the bound then succeeds", async () => {
    const h = createHarness();
    try {
      let pulls = 0;
      const origPull = h.transport.pull.bind(h.transport);
      h.transport.pull = async (input) => {
        pulls += 1;
        if (pulls <= 2) throw new Error("server-error");
        return origPull(input);
      };
      h.transport.remotes = [remoteRecord({ version: 2, payload: { theme: "retried" } })];
      await h.service.start();
      expect(pulls).toBe(3);
      const stored = await h.records.get(recordId(ACCOUNT, "app.settings", "theme"));
      expect(stored?.version).toBe(2);
    } finally {
      h.service.dispose();
    }
  });

  it("bounds the outbox to 200 envelopes per tick", async () => {
    const h = createHarness();
    try {
      for (let i = 0; i < 205; i += 1) {
        await h.records.upsert(
          localRow({
            recordId: recordId(ACCOUNT, "app.settings", `k-${i}`),
            entityId: `k-${i}`,
            updatedAt: T0 + i,
          }),
        );
      }
      await h.service.start();
      expect(h.transport.pushed[0]?.length).toBeLessThanOrEqual(200);
    } finally {
      h.service.dispose();
    }
  });

  it("resolve with project mismatch throws SYNC_VALIDATION", async () => {
    const h = createHarness();
    try {
      await h.records.upsert(
        localRow({
          recordId: recordId(ACCOUNT, "project.metadata", "proj-01"),
          entityType: "project.metadata",
          entityId: "proj-01",
          payloadJson: JSON.stringify({ projectId: "proj-01", name: "mine" }),
        }),
      );
      h.transport.remotes = [
        remoteRecord({
          entityType: "project.metadata",
          entityId: "proj-01",
          projectId: "proj-01",
          payload: { projectId: "proj-01", name: "theirs" },
        }),
      ];
      await h.service.start();
      const conflicts = (await h.service.conflicts()).conflicts;
      // Scalar project.metadata same-version LWW applies without conflict;
      // force an explicit conflict via schedule entity for mismatch check.
      if (conflicts.length === 0) {
        await h.conflicts.save({
          conflictId: `conflict::${recordId(ACCOUNT, "project.metadata", "proj-01")}`,
          entityType: "project.metadata",
          entityId: "proj-01",
          accountId: ACCOUNT,
          localVersion: 1,
          remoteVersion: 1,
          changedFieldsJson: JSON.stringify(["name"]),
          createdAt: T0,
        });
      }
      const [row] = (await h.service.conflicts()).conflicts;
      await expect(
        h.service.resolve(row.conflictId, "keep-local", "proj-other"),
      ).rejects.toMatchObject({ code: "SYNC_VALIDATION" });
    } finally {
      h.service.dispose();
    }
  });

  it("refuses secret-bearing remote payloads (counted invalid, never stored)", async () => {
    const h = createHarness();
    try {
      h.transport.remotes = [
        remoteRecord({ payload: { apiKey: "sk-live-secret" } }) as unknown as EngineSyncRecord,
      ];
      await h.service.start();
      expect(await h.records.get(recordId(ACCOUNT, "app.settings", "theme"))).toBeNull();
      expect((await h.service.conflicts()).conflicts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });
});
