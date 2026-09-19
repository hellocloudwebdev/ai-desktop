// PR45: apps/desktop — Sync + Account IPC registration tests (stub registry)
//
// No agent/__tests__ IPC test exists to mirror (only service suites), so this
// suite tests the register functions directly with a stub registry capturing
// channel -> schema -> handler, plus stub services. Covers: all 10 channels
// registered, malformed resolve choice rejected by the Zod schema, missing
// services throw fail-closed messages, and returned envelopes contain no
// token/secret keys.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, SyncResolveCommandSchema } from "@ai-desktop/shared";
import { registerAccountHandlers } from "../../account/account-ipc.js";
import { registerSyncHandlers } from "../sync-ipc.js";

interface CapturedEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: { safeParse: (data: unknown) => any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<any>;
}

class StubRegistry {
  readonly registrations = new Map<string, CapturedEntry>();
  registerCommand(
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any,
  ): void {
    if (this.registrations.has(channel)) {
      throw new Error(`duplicate channel ${channel}`);
    }
    this.registrations.set(channel, { schema, handler });
  }
}

const FORBIDDEN_KEY_PATTERN = /token|secret|nonce|password|credential|apikey|secretref/i;

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function expectNoSecrets(value: unknown): void {
  const keys = collectKeys(value);
  const leaked = keys.filter((key) => FORBIDDEN_KEY_PATTERN.test(key.replace(/[_-]/g, "")));
  expect(leaked).toEqual([]);
}

function makeAccountStub() {
  const session = {
    accountId: "01JACCOUNT0000000000000001",
    displayName: "Ada",
    email: "ada@example.com",
    session: "authenticated",
    deviceId: "01JDEVICE00000000000000001",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    // Secret-shaped extras the handler must strip:
    refreshToken: "should-never-leak",
    nonce: "should-never-leak",
    secretRef: "app/account/x/refresh-token",
  };
  const device = {
    deviceId: "01JDEVICE00000000000000001",
    accountId: "01JACCOUNT0000000000000001",
    deviceName: "desktop",
    platform: "linux",
    lastSeenAt: new Date(0).toISOString(),
    refreshToken: "should-never-leak",
  };
  return {
    async get() {
      return { ...session };
    },
    async signIn() {
      return { ...session };
    },
    async signOut() {
      return { signedOut: true, accountId: session.accountId };
    },
    async refresh() {
      return { ...session };
    },
    async device() {
      return { ...device };
    },
  };
}

function makeSyncStub() {
  const status = {
    status: "idle",
    pendingCount: 3,
    version: 1,
    lastSyncedAt: new Date(0).toISOString(),
    refreshToken: "should-never-leak",
    secret: "should-never-leak",
  };
  return {
    async status() {
      return { ...status };
    },
    async start() {
      return { ...status, status: "syncing" };
    },
    async pause() {
      return { ...status, status: "paused" };
    },
    async conflicts() {
      return [
        {
          conflictId: "conflict-1",
          entityType: "memory",
          localVersion: 2,
          remoteVersion: 3,
          refreshToken: "should-never-leak",
          secret: "should-never-leak",
        },
      ];
    },
    async resolve(conflictId: string, resolution: string) {
      return { conflictId, resolution, status: "resolved", secret: "should-never-leak" };
    },
  };
}

describe("account + sync IPC registration (PR45)", () => {
  it("registers all 10 channels (5 account + 5 sync)", () => {
    const registry = new StubRegistry();
    registerAccountHandlers(
      registry as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { accountService: makeAccountStub() as any },
    );
    registerSyncHandlers(
      registry as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { syncService: makeSyncStub() as any },
    );
    expect(registry.registrations.size).toBe(10);
    for (const channel of [
      IPC_CHANNELS.ACCOUNT_GET,
      IPC_CHANNELS.ACCOUNT_SIGN_IN,
      IPC_CHANNELS.ACCOUNT_SIGN_OUT,
      IPC_CHANNELS.ACCOUNT_REFRESH,
      IPC_CHANNELS.ACCOUNT_DEVICE,
      IPC_CHANNELS.SYNC_STATUS,
      IPC_CHANNELS.SYNC_START,
      IPC_CHANNELS.SYNC_PAUSE,
      IPC_CHANNELS.SYNC_CONFLICTS,
      IPC_CHANNELS.SYNC_RESOLVE,
    ]) {
      expect(registry.registrations.has(channel)).toBe(true);
    }
  });

  it("rejects a malformed resolve choice via the Zod schema", () => {
    const bad = SyncResolveCommandSchema.safeParse({
      conflictId: "conflict-1",
      resolution: "bogus-choice",
    });
    expect(bad.success).toBe(false);
  });

  it("accepts a resolve without projectId (globally keyed by conflictId)", () => {
    const good = SyncResolveCommandSchema.safeParse({
      conflictId: "conflict-1",
      resolution: "keep-local",
    });
    expect(good.success).toBe(true);
  });

  it("throws fail-closed messages when services are absent", () => {
    expect(() =>
      registerAccountHandlers(
        new StubRegistry() as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { accountService: undefined as any },
      ),
    ).toThrow("AccountService is not available");
    expect(() =>
      registerSyncHandlers(
        new StubRegistry() as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { syncService: undefined as any },
      ),
    ).toThrow("SyncService is not available");
  });

  it("returns envelopes with no token/secret keys", async () => {
    const accountRegistry = new StubRegistry();
    registerAccountHandlers(
      accountRegistry as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { accountService: makeAccountStub() as any },
    );
    const syncRegistry = new StubRegistry();
    registerSyncHandlers(
      syncRegistry as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { syncService: makeSyncStub() as any },
    );

    const accountGet = await accountRegistry.registrations
      .get(IPC_CHANNELS.ACCOUNT_GET)!
      .handler({});
    expectNoSecrets(accountGet);

    const signIn = await accountRegistry.registrations
      .get(IPC_CHANNELS.ACCOUNT_SIGN_IN)!
      .handler({ displayName: "Ada" });
    expectNoSecrets(signIn);

    const signOut = await accountRegistry.registrations
      .get(IPC_CHANNELS.ACCOUNT_SIGN_OUT)!
      .handler({});
    expectNoSecrets(signOut);

    const refresh = await accountRegistry.registrations
      .get(IPC_CHANNELS.ACCOUNT_REFRESH)!
      .handler({});
    expectNoSecrets(refresh);

    const device = await accountRegistry.registrations
      .get(IPC_CHANNELS.ACCOUNT_DEVICE)!
      .handler({});
    expectNoSecrets(device);

    const status = await syncRegistry.registrations.get(IPC_CHANNELS.SYNC_STATUS)!.handler({});
    expectNoSecrets(status);

    const start = await syncRegistry.registrations.get(IPC_CHANNELS.SYNC_START)!.handler({});
    expectNoSecrets(start);

    const pause = await syncRegistry.registrations.get(IPC_CHANNELS.SYNC_PAUSE)!.handler({});
    expectNoSecrets(pause);

    const conflicts = await syncRegistry.registrations
      .get(IPC_CHANNELS.SYNC_CONFLICTS)!
      .handler({ limit: 10 });
    expectNoSecrets(conflicts);

    const resolve = await syncRegistry.registrations
      .get(IPC_CHANNELS.SYNC_RESOLVE)!
      .handler({ conflictId: "conflict-1", resolution: "keep-remote" });
    expectNoSecrets(resolve);
  });
});
