// PR46: packages/storage — Secrets Boundary (adversarial)
//
// Locks: SecretStore round-trip, SecretRef rejects secret-shaped values,
// guarded repos refuse secret material BEFORE any DB write (fake DB fails
// loudly if touched, so a missing guard would persist instead of throwing).

import { describe, expect, it } from "vitest";
import { generateUlid, ValidationError } from "@ai-desktop/shared";
import { asSecretRef, parseSecretRef, type SecretRef } from "../secrets/secret-ref.js";
import { validateSecretInputs, type SecretStore } from "../secrets/secret-store.js";
import {
  PrismaSyncRecordRepository,
  SyncSecretError,
  type SyncRecordRow,
} from "../sync/sync-repository.js";
import {
  PrismaScheduledTaskRepository,
  type ScheduledTaskRow,
} from "../scheduling/scheduled-task-repository.js";
import {
  PrismaBackgroundTaskRepository,
  type BackgroundTaskRow,
} from "../background/background-task-repository.js";
import type { StorageDatabase } from "../client/database.js";

class InMemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, string>();
  async set(ref: SecretRef, secret: string): Promise<void> {
    validateSecretInputs(ref, secret, true);
    this.entries.set(ref, secret);
  }
  async get(ref: SecretRef): Promise<string | null> {
    validateSecretInputs(ref);
    return this.entries.get(ref) ?? null;
  }
  async delete(ref: SecretRef): Promise<void> {
    validateSecretInputs(ref);
    this.entries.delete(ref);
  }
  async has(ref: SecretRef): Promise<boolean> {
    validateSecretInputs(ref);
    return this.entries.has(ref);
  }
}

function testRef(label: string): SecretRef {
  return asSecretRef(`ai-desktop/test/${generateUlid().toLowerCase()}-${label}`);
}

/** Fake DB that throws if any write is attempted (proves refusal precedes persistence). */
function explodingDb(): StorageDatabase {
  const boom = async (): Promise<never> => {
    throw new Error("DB_TOUCHED: guard failed to refuse before persistence");
  };
  return {
    client: {
      syncRecord: {
        upsert: boom,
        findUnique: boom,
        findMany: boom,
        delete: boom,
        deleteMany: boom,
      },
      syncCursor: { upsert: boom, findUnique: boom, findMany: boom, delete: boom },
      syncConflict: {
        upsert: boom,
        findUnique: boom,
        findMany: boom,
        delete: boom,
        deleteMany: boom,
      },
      scheduledTask: { upsert: boom, findUnique: boom, findMany: boom },
      scheduledRun: { upsert: boom, findUnique: boom, findMany: boom },
      backgroundTask: { upsert: boom, findUnique: boom, findMany: boom },
    },
  } as unknown as StorageDatabase;
}

function syncRow(overrides: Partial<SyncRecordRow> = {}): SyncRecordRow {
  return {
    recordId: generateUlid(),
    entityType: "app.settings",
    entityId: "entity-1",
    accountId: "acc-1",
    deviceId: "dev-1",
    version: 1,
    payloadJson: JSON.stringify({ theme: "dark" }),
    updatedAt: Date.now(),
    deletedAt: null,
    ...overrides,
  };
}

describe("storage secrets-boundary: SecretStore round-trip", () => {
  it("round-trips without ever returning secrets from set()", async () => {
    const store = new InMemorySecretStore();
    const ref = testRef("roundtrip");
    const setResult = await store.set(ref, "test-secret-value-abc");
    expect(setResult).toBeUndefined();
    await expect(store.get(ref)).resolves.toBe("test-secret-value-abc");
    expect(await store.has(ref)).toBe(true);
    await store.delete(ref);
    expect(await store.has(ref)).toBe(false);
    await expect(store.get(ref)).resolves.toBeNull();
  });

  it("missing credential returns null while backend failure throws distinctly", async () => {
    const store = new InMemorySecretStore();
    await expect(store.get(testRef("missing"))).resolves.toBeNull();
  });
});

describe("storage secrets-boundary: SecretRef rejects secret-shaped values", () => {
  it("rejects values with =, whitespace, uppercase, or embedded secrets", () => {
    expect(() => parseSecretRef("app/provider/anthropic/api-key=sk-fake")).toThrow(ValidationError);
    expect(() => parseSecretRef("app/provider/api key/name")).toThrow(ValidationError);
    expect(() => parseSecretRef("App/Provider/Anthropic/Key")).toThrow(ValidationError);
    expect(() => parseSecretRef("Bearer mytoken1234567890")).toThrow(ValidationError);
    expect(() => parseSecretRef("single")).toThrow(ValidationError);
    expect(() => parseSecretRef("")).toThrow(ValidationError);
  });

  it("accepts well-formed refs and rejects trusted-cast smuggling at the boundary", async () => {
    const ok = parseSecretRef("app/provider/anthropic/api-key");
    expect(typeof ok).toBe("string");
    const store = new InMemorySecretStore();
    const smuggled = asSecretRef("bad ref=with-secret");
    await expect(store.set(smuggled, "x")).rejects.toThrow(ValidationError);
    await expect(store.get(smuggled)).rejects.toThrow(ValidationError);
  });
});

describe("storage secrets-boundary: guarded repos refuse before persistence", () => {
  it("sync repo refuses secret-bearing payloads without touching the DB", async () => {
    const repo = new PrismaSyncRecordRepository(explodingDb());
    await expect(
      repo.upsert(syncRow({ payloadJson: JSON.stringify({ api_key: "sk-live-12345678" }) })),
    ).rejects.toThrow(SyncSecretError);
    await expect(
      repo.upsert(syncRow({ payloadJson: "Bearer mytoken1234567890 in payload" })),
    ).rejects.toThrow(SyncSecretError);
    // Clean payload would reach the DB (explodes) — proves the guard is what refused above.
    await expect(repo.upsert(syncRow())).rejects.toThrow(/DB_TOUCHED/);
  });

  it("scheduled-task repo refuses secret name/prompt without touching the DB", async () => {
    const repo = new PrismaScheduledTaskRepository(explodingDb());
    const base: ScheduledTaskRow = {
      scheduleId: generateUlid(),
      projectId: "proj-a",
      name: "Hourly summary",
      description: null,
      prompt: "Summarize changes.",
      kind: "interval",
      configJson: "{}",
      timezone: "UTC",
      enabled: true,
      missedPolicy: "skip",
      overlapPolicy: "skip",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      missedCount: 0,
      schemaVersion: 1,
    };
    await expect(
      repo.upsert({ ...base, prompt: "do it api_key=sk-live-12345678" }),
    ).rejects.toThrow();
    await expect(repo.upsert({ ...base, name: "x password= hunter99-secret" })).rejects.toThrow();
  });

  it("background-task repo refuses secret goal/title without touching the DB", async () => {
    const repo = new PrismaBackgroundTaskRepository(explodingDb());
    const base: BackgroundTaskRow = {
      taskId: generateUlid(),
      conversationId: generateUlid(),
      projectId: "proj-a",
      title: "Refactor",
      goal: "Refactor the module.",
      mode: "background",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 0,
      nodeCount: 0,
      schemaVersion: 1,
    };
    await expect(
      repo.upsert({ ...base, goal: "goal with secret=sk-live-12345678" }),
    ).rejects.toThrow();
    await expect(repo.upsert({ ...base, title: "Bearer mytoken1234567890" })).rejects.toThrow();
  });
});
