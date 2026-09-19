// PR45: packages/agent-runtime — Account Session Tests (CORE ENGINE layer)
//
// Covers the AccountSessionManager state machine (legal transitions only,
// nonce memory-only, refresh token in SecretStore only, refresh failure ->
// expired, sign-out -> signed_out + onSyncStop with local data untouched)
// and the LocalAuthProvider offline profile behavior.

import { describe, expect, it } from "vitest";
import { createAccountId, createDeviceId } from "@ai-desktop/ai-core";
import {
  AccountSessionError,
  AccountSessionManager,
  accountRefreshTokenRef,
  type SessionAuthProvider,
} from "../runtime/account/account-session-manager.js";
import { createOpaqueHex, LocalAuthProvider } from "../runtime/account/local-auth-provider.js";

/** In-memory SessionSecretStore double. */
class FakeSecretStore {
  readonly data = new Map<string, string>();

  async set(ref: string, secret: string): Promise<void> {
    this.data.set(ref, secret);
  }

  async get(ref: string): Promise<string | null> {
    return this.data.get(ref) ?? null;
  }

  async delete(ref: string): Promise<void> {
    this.data.delete(ref);
  }
}

/** Controllable auth provider double (ULID account scope). */
class FakeAuthProvider implements SessionAuthProvider {
  readonly accountId = createAccountId();
  beginCalls = 0;
  rotateCalls = 0;
  failBegin = false;
  failRotate = false;

  async begin(input: { displayName: string; email?: string }) {
    this.beginCalls += 1;
    if (this.failBegin) throw new Error("provider down");
    return {
      accountId: this.accountId,
      displayName: input.displayName,
      ...(input.email !== undefined ? { email: input.email } : {}),
      nonce: `nonce-${this.beginCalls}`,
      refreshToken: `refresh-${this.beginCalls}`,
    };
  }

  async rotate() {
    this.rotateCalls += 1;
    if (this.failRotate) throw new Error("rotation rejected");
    return { nonce: `nonce-r${this.rotateCalls}`, refreshToken: `refresh-r${this.rotateCalls}` };
  }

  async signOut(): Promise<void> {
    return undefined;
  }
}

function setup() {
  const auth = new FakeAuthProvider();
  const secrets = new FakeSecretStore();
  const deviceId = createDeviceId();
  let syncStops = 0;
  const manager = new AccountSessionManager({
    authProvider: auth,
    secretStore: secrets,
    getOrCreateDeviceId: () => deviceId,
    clock: () => 1_700_000_000_000,
    onSyncStop: () => {
      syncStops += 1;
    },
  });
  return { auth, secrets, manager, deviceId, stops: () => syncStops };
}

describe("AccountSessionManager sign-in", () => {
  it("signs in through authenticating to authenticated with secrets quarantined", async () => {
    const { auth, secrets, manager, deviceId } = setup();
    const session = await manager.signIn({ displayName: "Ada", email: "ada@example.com" });
    expect(auth.beginCalls).toBe(1);
    expect(session).toMatchObject({
      accountId: auth.accountId,
      deviceId,
      status: "authenticated",
    });
    expect(manager.getStatus()).toBe("authenticated");
    expect(manager.getAccountId()).toBe(auth.accountId);
    // Refresh token ONLY in the SecretStore under the canonical ref.
    expect(secrets.data.get(accountRefreshTokenRef(auth.accountId))).toBe("refresh-1");
    // Nonce is memory-only and tracked without exposing the value.
    expect(manager.hasNonce(auth.accountId)).toBe(true);
    // The session snapshot carries no secret material.
    expect(Object.keys(session).sort()).toEqual(
      ["accountId", "createdAt", "deviceId", "status"].sort(),
    );
    expect(JSON.stringify(session)).not.toContain("refresh-1");
  });

  it("rejects invalid and secret-bearing input without touching state", async () => {
    const { manager } = setup();
    await expect(manager.signIn({ displayName: "" })).rejects.toMatchObject({
      code: "validation-error",
    });
    await expect(manager.signIn({ displayName: "x".repeat(121) })).rejects.toMatchObject({
      code: "validation-error",
    });
    await expect(manager.signIn({ displayName: "leak my secret here" })).rejects.toMatchObject({
      code: "secret-refused",
    });
    expect(manager.getStatus()).toBe("signed_out");
    expect(manager.getSession()).toBeNull();
  });

  it("forbids sign-in while already authenticated", async () => {
    const { manager } = setup();
    await manager.signIn({ displayName: "Ada" });
    await expect(manager.signIn({ displayName: "Ada" })).rejects.toMatchObject({
      code: "invalid-transition",
    });
  });

  it("uses the injected device factory", async () => {
    const secrets = new FakeSecretStore();
    const customDeviceId = createDeviceId();
    const manager = new AccountSessionManager({
      authProvider: new LocalAuthProvider(),
      secretStore: secrets,
      getOrCreateDeviceId: () => customDeviceId,
    });
    const session = await manager.signIn({ displayName: "Ada" });
    expect(session.deviceId).toBe(customDeviceId);
  });

  it("maps provider failure to error state", async () => {
    const { auth, manager } = setup();
    auth.failBegin = true;
    await expect(manager.signIn({ displayName: "Ada" })).rejects.toMatchObject({
      code: "auth-failed",
    });
    expect(manager.getStatus()).toBe("error");
    // Recovery from error re-signs in.
    auth.failBegin = false;
    const session = await manager.signIn({ displayName: "Ada" });
    expect(session.status).toBe("authenticated");
  });
});

describe("AccountSessionManager refresh", () => {
  it("rotates nonce + refresh token staying authenticated", async () => {
    const { auth, secrets, manager } = setup();
    await manager.signIn({ displayName: "Ada" });
    const before = secrets.data.get(accountRefreshTokenRef(auth.accountId));
    const refreshed = await manager.refresh();
    expect(auth.rotateCalls).toBe(1);
    expect(refreshed.status).toBe("authenticated");
    expect(refreshed.lastRefreshAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(secrets.data.get(accountRefreshTokenRef(auth.accountId))).toBe("refresh-r1");
    expect(secrets.data.get(accountRefreshTokenRef(auth.accountId))).not.toBe(before);
    expect(manager.hasNonce(auth.accountId)).toBe(true);
  });

  it("requires an authenticated session", async () => {
    const { manager } = setup();
    await expect(manager.refresh()).rejects.toMatchObject({ code: "not-signed-in" });
  });

  it("expires when the refresh entry is missing", async () => {
    const { auth, secrets, manager } = setup();
    await manager.signIn({ displayName: "Ada" });
    await secrets.delete(accountRefreshTokenRef(auth.accountId));
    await expect(manager.refresh()).rejects.toMatchObject({ code: "expired" });
    expect(manager.getStatus()).toBe("expired");
    // Expired sessions re-sign in; refresh stays illegal from expired.
    await expect(manager.refresh()).rejects.toMatchObject({ code: "invalid-transition" });
    const session = await manager.signIn({ displayName: "Ada" });
    expect(session.status).toBe("authenticated");
  });

  it("expires on rotation failure", async () => {
    const { auth, manager } = setup();
    await manager.signIn({ displayName: "Ada" });
    auth.failRotate = true;
    await expect(manager.refresh()).rejects.toMatchObject({ code: "expired" });
    expect(manager.getStatus()).toBe("expired");
  });
});

describe("AccountSessionManager sign-out", () => {
  it("clears nonce + refresh entry, stops sync, keeps local profile", async () => {
    const provider = new LocalAuthProvider();
    const secrets = new FakeSecretStore();
    const deviceId = createDeviceId();
    let syncStops = 0;
    const manager = new AccountSessionManager({
      authProvider: provider,
      secretStore: secrets,
      getOrCreateDeviceId: () => deviceId,
      onSyncStop: () => {
        syncStops += 1;
      },
    });
    const first = await manager.signIn({ displayName: "Ada", email: "ada@example.com" });
    const outcome = await manager.signOut();
    expect(outcome).toEqual({ signedOut: true, accountId: first.accountId });
    expect(manager.getStatus()).toBe("signed_out");
    expect(manager.hasNonce(first.accountId)).toBe(false);
    expect(await secrets.get(accountRefreshTokenRef(first.accountId))).toBeNull();
    expect(syncStops).toBe(1);
    // Local data untouched: re-sign-in loads the SAME profile.
    const second = await manager.signIn({ displayName: "Ada", email: "ada@example.com" });
    expect(second.accountId).toBe(first.accountId);
    expect(provider.getAccount(first.accountId)?.displayName).toBe("Ada");
  });

  it("is idempotent and never fails on sync-stop errors", async () => {
    const { manager, stops } = setup();
    await manager.signIn({ displayName: "Ada" });
    await manager.signOut();
    const again = await manager.signOut();
    expect(again).toEqual({ signedOut: true, accountId: null });
    expect(stops()).toBe(2);

    const failing = new AccountSessionManager({
      authProvider: new FakeAuthProvider(),
      secretStore: new FakeSecretStore(),
      onSyncStop: () => {
        throw new Error("sync teardown blew up");
      },
    });
    await failing.signIn({ displayName: "Ada" });
    await expect(failing.signOut()).resolves.toMatchObject({ signedOut: true });
    expect(failing.getStatus()).toBe("signed_out");
  });
});

describe("accountRefreshTokenRef", () => {
  it("builds the canonical lowercase refresh-token ref", () => {
    expect(accountRefreshTokenRef("01JABCDEF")).toBe("app/account/01jabcdef/refresh-token");
  });
});

describe("LocalAuthProvider", () => {
  it("creates then loads the same profile with fresh opaque material", async () => {
    const provider = new LocalAuthProvider({ clock: () => 1_700_000_000_000 });
    const first = await provider.begin({ displayName: "Ada", email: "ada@example.com" });
    const second = await provider.begin({ displayName: "Ada", email: "ada@example.com" });
    expect(second.accountId).toBe(first.accountId);
    expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(first.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(provider.getAccount(first.accountId)).toMatchObject({ displayName: "Ada" });
  });

  it("issues distinct accountIds per identity and rejects bad input", async () => {
    const provider = new LocalAuthProvider();
    const ada = await provider.begin({ displayName: "Ada" });
    const bob = await provider.begin({ displayName: "Bob" });
    expect(bob.accountId).not.toBe(ada.accountId);
    await expect(provider.begin({ displayName: "" })).rejects.toBeInstanceOf(AccountSessionError);
  });

  it("rotates known accounts and expires unknown ones; signOut preserves profiles", async () => {
    const provider = new LocalAuthProvider();
    const { accountId } = await provider.begin({ displayName: "Ada" });
    const rotated = await provider.rotate({ accountId });
    expect(rotated.nonce).toMatch(/^[0-9a-f]{64}$/);
    await expect(provider.rotate({ accountId: createAccountId() })).rejects.toMatchObject({
      code: "expired",
    });
    await provider.signOut();
    expect(provider.getAccount(accountId)?.displayName).toBe("Ada");
  });

  it("mints 32-byte hex material", () => {
    expect(createOpaqueHex(32)).toMatch(/^[0-9a-f]{64}$/);
    expect(createOpaqueHex(32)).not.toBe(createOpaqueHex(32));
  });
});
