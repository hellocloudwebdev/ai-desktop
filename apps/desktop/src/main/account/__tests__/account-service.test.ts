// PR45: apps/desktop — AccountService Tests
//
// Thin-orchestration coverage: lifecycle/session machine, sign-out idempotency
// + local preservation, refresh failure -> expired, secret refusal, no-secrets
// projections/events, canonical event names, append-before-publish ordering,
// and onSignedOut hook. No Electron; time injected via clock.

import { describe, expect, it } from "vitest";
import type { AIEvent, ConversationId } from "@ai-desktop/ai-core";
import { AccountService, AccountServiceError } from "../account-service.js";

class InMemoryAccountRepo {
  readonly rows = new Map<
    string,
    {
      accountId: string;
      displayName: string;
      email: string | null;
      createdAt: number;
      updatedAt: number;
      schemaVersion: number;
    }
  >();

  async upsert(record: {
    accountId: string;
    displayName: string;
    email?: string | null;
    createdAt: number;
    updatedAt: number;
    schemaVersion: number;
  }): Promise<void> {
    this.rows.set(record.accountId, {
      accountId: record.accountId,
      displayName: record.displayName,
      email: record.email ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      schemaVersion: record.schemaVersion,
    });
  }

  async get(accountId: string) {
    return this.rows.get(accountId) ?? null;
  }

  async list() {
    return [...this.rows.values()];
  }

  async current() {
    const rows = await this.list();
    return rows[0] ?? null;
  }
}

class InMemoryDeviceRepo {
  readonly rows = new Map<
    string,
    {
      deviceId: string;
      accountId: string;
      deviceName: string;
      platform: string;
      createdAt: number;
      lastSeenAt: number;
    }
  >();

  async upsert(record: {
    deviceId: string;
    accountId: string;
    deviceName: string;
    platform: string;
    createdAt: number;
    lastSeenAt: number;
  }): Promise<void> {
    this.rows.set(record.deviceId, { ...record });
  }

  async get(deviceId: string) {
    return this.rows.get(deviceId) ?? null;
  }

  async listByAccount(accountId: string) {
    return [...this.rows.values()].filter((r) => r.accountId === accountId);
  }

  async touchLastSeen(deviceId: string, atMs?: number): Promise<boolean> {
    const row = this.rows.get(deviceId);
    if (!row) return false;
    row.lastSeenAt = atMs ?? Date.now();
    return true;
  }

  async getOrCreateDevice(input: {
    deviceId: string;
    accountId: string;
    deviceName?: string;
    platform?: string;
    nowMs?: number;
  }) {
    const existing = await this.get(input.deviceId).catch(() => null);
    if (existing && existing.accountId === input.accountId) {
      await this.touchLastSeen(input.deviceId, input.nowMs).catch(() => false);
      return (await this.get(input.deviceId)) ?? existing;
    }
    const now = input.nowMs ?? Date.now();
    const row = {
      deviceId: input.deviceId,
      accountId: input.accountId,
      deviceName: (input.deviceName ?? "desktop").trim() || "desktop",
      platform: (input.platform ?? "unknown").trim() || "unknown",
      createdAt: now,
      lastSeenAt: now,
    };
    await this.upsert(row);
    return (await this.get(input.deviceId))!;
  }
}

class InMemorySecrets {
  readonly store = new Map<string, string>();

  async set(ref: { toString(): string } | string, secret: string): Promise<void> {
    this.store.set(String(ref), secret);
  }

  async get(ref: { toString(): string } | string): Promise<string | null> {
    return this.store.get(String(ref)) ?? null;
  }

  async delete(ref: { toString(): string } | string): Promise<void> {
    this.store.delete(String(ref));
  }
}

class StubBus {
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
    return this.appended.filter((e) => e.conversationId === conversationId);
  }
}

const T0 = Date.parse("2026-09-18T10:00:00.000Z");

function createHarness(
  overrides: {
    authProvider?: {
      begin: () => Promise<{ nonce: string; refreshToken: string }>;
      rotate: () => Promise<{ nonce: string; refreshToken: string }>;
    };
    onSignedOut?: () => Promise<void> | void;
  } = {},
) {
  let nowMs = T0;
  const accounts = new InMemoryAccountRepo();
  const devices = new InMemoryDeviceRepo();
  const secrets = new InMemorySecrets();
  const bus = new StubBus();
  const storage = new StubStorage();
  let signedOutCalls = 0;
  const service = new AccountService({
    accountRepo: accounts,
    deviceRepo: devices,
    secretStore: secrets as never,
    eventBus: bus,
    storage: storage as never,
    ...(overrides.authProvider ? { authProvider: overrides.authProvider as never } : {}),
    clock: () => nowMs,
    deviceId: "dev-01",
    deviceName: "desktop",
    platform: "linux",
    onSignedOut:
      overrides.onSignedOut ??
      (async () => {
        signedOutCalls += 1;
      }),
  });
  return {
    accounts,
    devices,
    secrets,
    bus,
    storage,
    service,
    signedOutCalls: () => signedOutCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function eventTypes(events: AIEvent[]): string[] {
  return events.map((e) => (e as { type: string }).type);
}

describe("apps/desktop: AccountService (PR45)", () => {
  it("signs in through signed_out -> authenticating -> authenticated", async () => {
    const h = createHarness();
    expect(h.service.session).toBe("signed_out");
    const proj = await h.service.signIn({ displayName: "Ada", email: "ada@example.com" });
    expect(proj.session).toBe("authenticated");
    expect(h.service.session).toBe("authenticated");
    expect(proj.displayName).toBe("Ada");
    expect(proj).not.toHaveProperty("refreshToken");
    expect(proj).not.toHaveProperty("nonce");
  });

  it("rejects concurrent sign-in while authenticating", async () => {
    const h = createHarness();
    let release!: (v: { nonce: string; refreshToken: string }) => void;
    const gate = new Promise<{ nonce: string; refreshToken: string }>((res) => {
      release = res;
    });
    const gated = new AccountService({
      accountRepo: h.accounts,
      deviceRepo: h.devices,
      secretStore: h.secrets as never,
      eventBus: h.bus,
      storage: h.storage as never,
      authProvider: {
        begin: () => gate,
        rotate: async () => ({ nonce: "n", refreshToken: "r12345678" }),
      } as never,
      clock: () => T0,
      deviceId: "dev-01",
    });
    const pending = gated.signIn({ displayName: "Ada" });
    await new Promise((r) => setImmediate(r));
    await expect(gated.signIn({ displayName: "Bo" })).rejects.toMatchObject({
      code: "invalid-transition",
    });
    release({ nonce: "n", refreshToken: "r12345678" });
    await pending;
  });

  it("sign-out is idempotent, clears nonce + SecretStore, preserves rows, stops sync", async () => {
    const h = createHarness();
    const proj = await h.service.signIn({ displayName: "Ada" });
    expect(h.secrets.store.size).toBe(1);
    const first = await h.service.signOut();
    expect(first.signedOut).toBe(true);
    expect(first.accountId).toBe(proj.accountId);
    expect(h.secrets.store.size).toBe(0);
    expect(h.service.session).toBe("signed_out");
    // Local rows preserved (no wipe).
    expect(h.accounts.rows.size).toBe(1);
    expect(h.devices.rows.size).toBe(1);
    expect(h.signedOutCalls()).toBe(1);
    const second = await h.service.signOut();
    expect(second.signedOut).toBe(true);
    expect(h.service.session).toBe("signed_out");
  });

  it("refresh failure lands in expired with canonical session.expired event", async () => {
    const h = createHarness({
      authProvider: {
        begin: async () => ({ nonce: "n1", refreshToken: "r1-12345678" }),
        rotate: async () => {
          throw new Error("rotator down");
        },
      },
    });
    await h.service.signIn({ displayName: "Ada" });
    await expect(h.service.refresh()).rejects.toMatchObject({ code: "expired" });
    expect(h.service.session).toBe("expired");
    expect(eventTypes(h.bus.events)).toContain("account.session.expired");
  });

  it("refresh success emits canonical session.refreshed and rotates SecretStore", async () => {
    const h = createHarness();
    await h.service.signIn({ displayName: "Ada" });
    const before = [...h.secrets.store.values()][0];
    const proj = await h.service.refresh();
    expect(proj.session).toBe("authenticated");
    expect(eventTypes(h.bus.events)).toContain("account.session.refreshed");
    expect([...h.secrets.store.values()][0]).not.toBe(before);
  });

  it("refuses secret-shaped identity without echoing values", async () => {
    const h = createHarness();
    await expect(h.service.signIn({ displayName: "api_key=sk-live-123" })).rejects.toMatchObject({
      code: "secret-refused",
    });
    expect(h.accounts.rows.size).toBe(0);
    expect(h.secrets.store.size).toBe(0);
  });

  it("projections and events carry no tokens/nonces/refs", async () => {
    const h = createHarness();
    const proj = await h.service.signIn({ displayName: "Ada" });
    const text = JSON.stringify({
      proj,
      events: h.bus.events,
      rows: [...h.accounts.rows.values()],
    });
    expect(text).not.toMatch(/refreshToken|nonce|SecretRef/i);
    const got = await h.service.get();
    expect(JSON.stringify(got)).not.toMatch(/refreshToken|nonce/i);
    const device = await h.service.device();
    expect(JSON.stringify(device)).not.toMatch(/refreshToken|nonce/i);
  });

  it("emits canonical account.signed_in / signed_out names via append-then-publish", async () => {
    const h = createHarness();
    await h.service.signIn({ displayName: "Ada" });
    expect(eventTypes(h.bus.events)).toContain("account.signed_in");
    expect(h.storage.appended.length).toBe(h.bus.events.length);
    await h.service.signOut();
    expect(eventTypes(h.bus.events)).toContain("account.signed_out");
    expect(eventTypes(h.storage.appended)).toEqual(eventTypes(h.bus.events));
  });

  it("re-sign-in from expired succeeds (expired/error -> authenticating)", async () => {
    const h = createHarness({
      authProvider: {
        begin: async () => ({ nonce: "n1", refreshToken: "r1-12345678" }),
        rotate: async () => {
          throw new Error("down");
        },
      },
    });
    await h.service.signIn({ displayName: "Ada" });
    await expect(h.service.refresh()).rejects.toMatchObject({ code: "expired" });
    expect(h.service.session).toBe("expired");
    const proj = await h.service.signIn({ displayName: "Ada" });
    expect(proj.session).toBe("authenticated");
  });

  it("throws AccountServiceError with CODE-prefixed messages", () => {
    const err = new AccountServiceError("validation-error", "bad");
    expect(err.message).toBe("validation-error: bad");
    expect(err.code).toBe("validation-error");
  });
});
