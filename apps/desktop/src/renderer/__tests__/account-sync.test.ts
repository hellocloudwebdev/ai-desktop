// PR45: renderer — Accounts & Cross-Device Sync tests (store/projection-level)
//
// Pure/store-level coverage for the Account renderer layer: vocabulary,
// projection normalization, session/sync labels, sign-in validation,
// disconnect-requery through the local stub, sign-out preserves local data,
// sync start/pause, offline/conflict simulation, explicit conflict resolve
// paths, secret hygiene, relative-time formatting, and render caps.
// Component-contract assertions follow the repo's established
// source-assertion pattern (pure, no Electron, no DOM).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFLICT_RESOLUTIONS,
  MAX_ACCOUNT_DISPLAY_NAME,
  MAX_ACCOUNT_SYNC_ROWS,
  MAX_CONFLICTS_SHOWN,
  SESSION_STATUSES,
  SYNC_STATUSES,
  conflictCount,
  createLocalAccountSyncStub,
  fetchAccountSession,
  fetchDevice,
  fetchSyncConflicts,
  fetchSyncStatus,
  formatAccountTimestamp,
  formatRelativeTime,
  getAccountCommands,
  getSyncCommands,
  isSignInFormValid,
  looksSecretShaped,
  normalizeAccountSession,
  normalizeDeviceView,
  normalizeSyncConflict,
  normalizeSyncConflicts,
  normalizeSyncStatus,
  pauseSync,
  pendingSyncCount,
  redactSecretAssignments,
  refreshSession,
  resolveConflict,
  sessionStatusLabel,
  signInAccount,
  signOutAccount,
  startSync,
  syncNeedsAttention,
  syncStatusBadgeClass,
  syncStatusIndicator,
  syncStatusLabel,
  truncateDisplayName,
  truncateText,
  unwrapAccountSession,
  unwrapDevice,
  unwrapSyncConflicts,
  unwrapSyncStatus,
  validateSignInForm,
  type AccountSessionView,
  type SyncConflictView,
} from "../workspace/account-sync.js";

const SURFACE = path.resolve(__dirname, "../components/workspace/surfaces/AccountSurface.tsx");
const BRIDGE = path.resolve(__dirname, "../workspace/account-sync.ts");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const SIDEBAR = path.resolve(__dirname, "../components/workspace/WorkspaceSidebar.tsx");
const MAIN = path.resolve(__dirname, "../components/workspace/WorkspaceMain.tsx");
const TYPES = path.resolve(__dirname, "../workspace/types.ts");
const SURFACES = path.resolve(__dirname, "../workspace/surfaces.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function makeSession(overrides: Partial<AccountSessionView> = {}): AccountSessionView {
  return {
    status: "authenticated",
    displayName: "Ada",
    identifier: "ada@example.com",
    ...overrides,
  };
}

function makeConflict(
  overrides: Partial<SyncConflictView> & { conflictId: string },
): SyncConflictView {
  return {
    entity: "memory",
    entityId: "fact-01",
    localVersion: "v3",
    remoteVersion: "v4",
    changedFields: ["content"],
    ...overrides,
  };
}

describe("renderer: account/sync vocabulary (PR45)", () => {
  it("exposes the canonical session and sync states", () => {
    expect([...SESSION_STATUSES].sort()).toEqual([
      "authenticated",
      "authenticating",
      "error",
      "expired",
      "refreshing",
      "signed_out",
    ]);
    expect([...SYNC_STATUSES].sort()).toEqual(["conflict", "error", "idle", "offline", "syncing"]);
    expect(CONFLICT_RESOLUTIONS).toEqual(["keep-local", "keep-remote"]);
  });

  it("carries no token/secret vocabulary in renderer state", () => {
    const bridge = read(BRIDGE);
    for (const forbidden of ["accessToken", "refreshToken", "apiKey", "clientSecret"]) {
      expect(bridge).not.toContain(forbidden);
    }
    expect(SESSION_STATUSES as readonly string[]).not.toContain("token");
  });

  it("labels sessions and sync states", () => {
    expect(sessionStatusLabel("signed_out")).toBe("Signed out");
    expect(sessionStatusLabel("authenticating")).toBe("Signing in…");
    expect(sessionStatusLabel("authenticated")).toBe("Signed in");
    expect(sessionStatusLabel("refreshing")).toBe("Refreshing…");
    expect(sessionStatusLabel("expired")).toBe("Session expired");
    expect(sessionStatusLabel("error")).toBe("Sign-in error");
    expect(syncStatusLabel("idle")).toBe("Idle");
    expect(syncStatusLabel("syncing")).toBe("Syncing");
    expect(syncStatusBadgeClass("conflict")).toContain("amber");
  });

  it("renders the canonical sync indicators", () => {
    expect(syncStatusIndicator("idle")).toBe("Synced");
    expect(syncStatusIndicator("syncing")).toBe("Syncing…");
    expect(syncStatusIndicator("offline")).toBe("Offline");
    expect(syncStatusIndicator("error")).toBe("Needs attention");
    expect(syncStatusIndicator("conflict")).toBe("Conflict");
  });

  it("flags attention states for the sidebar dot", () => {
    expect(syncNeedsAttention("offline")).toBe(true);
    expect(syncNeedsAttention("error")).toBe(true);
    expect(syncNeedsAttention("conflict")).toBe(true);
    expect(syncNeedsAttention("idle")).toBe(false);
    expect(syncNeedsAttention("syncing")).toBe(false);
  });
});

describe("renderer: account/sync projection normalization (PR45)", () => {
  it("accepts IPC envelopes and raw payloads", () => {
    const session = makeSession();
    expect(
      normalizeAccountSession(unwrapAccountSession({ ok: true, value: { session } })),
    ).toMatchObject({
      status: "authenticated",
    });
    expect(
      normalizeAccountSession(unwrapAccountSession({ ok: true, value: session })),
    ).toMatchObject({
      displayName: "Ada",
    });
    expect(normalizeAccountSession(unwrapAccountSession(session))).toMatchObject({
      identifier: "ada@example.com",
    });
    expect(normalizeAccountSession(unwrapAccountSession({ ok: false }))).toBeNull();
    expect(normalizeAccountSession(unwrapAccountSession(null))).toBeNull();
  });

  it("accepts sibling spelling variants without a renderer change", () => {
    const variant = { status: "authenticated", name: "Grace", email: "grace@example.com" };
    const view = normalizeAccountSession(variant);
    expect(view?.displayName).toBe("Grace");
    expect(view?.identifier).toBe("grace@example.com");
  });

  it("rejects malformed sessions and unknown states", () => {
    expect(normalizeAccountSession({ status: "logged_in" })).toBeNull();
    expect(normalizeAccountSession({})).toBeNull();
    expect(normalizeAccountSession(null)).toBeNull();
    expect(normalizeAccountSession("session")).toBeNull();
  });

  it("normalizes devices with spelling variants", () => {
    expect(
      normalizeDeviceView({ deviceId: "d1", deviceName: "Laptop", platform: "darwin" }),
    ).toMatchObject({ deviceId: "d1", deviceName: "Laptop" });
    expect(normalizeDeviceView({ id: "d2", name: "Desktop" })?.deviceId).toBe("d2");
    expect(normalizeDeviceView({ deviceId: "", deviceName: "x" })).toBeNull();
    expect(normalizeDeviceView({ deviceId: "d1" })).toBeNull();
    expect(normalizeDeviceView(null)).toBeNull();
  });

  it("normalizes sync status with count defaults", () => {
    const view = normalizeSyncStatus({ status: "syncing" });
    expect(view).toMatchObject({
      status: "syncing",
      pendingCount: 0,
      conflictCount: 0,
      paused: false,
    });
    expect(
      normalizeSyncStatus({ status: "idle", pendingCount: 3, conflictCount: 1, paused: true }),
    ).toMatchObject({
      pendingCount: 3,
      conflictCount: 1,
      paused: true,
    });
    expect(
      normalizeSyncStatus(unwrapSyncStatus({ ok: true, value: { sync: { status: "offline" } } }))
        ?.status,
    ).toBe("offline");
    expect(normalizeSyncStatus({ status: "bogus" })).toBeNull();
    expect(normalizeSyncStatus(null)).toBeNull();
  });

  it("normalizes conflicts with version and field details", () => {
    const conflict = makeConflict({ conflictId: "c1" });
    expect(
      normalizeSyncConflicts(unwrapSyncConflicts({ ok: true, value: { conflicts: [conflict] } })),
    ).toHaveLength(1);
    expect(
      normalizeSyncConflicts(unwrapSyncConflicts({ ok: true, value: [conflict] })),
    ).toHaveLength(1);
    expect(normalizeSyncConflicts(unwrapSyncConflicts([conflict]))).toHaveLength(1);
    expect(unwrapSyncConflicts({ ok: false })).toEqual([]);
    expect(normalizeSyncConflict({ ...conflict, conflictId: "" })).toBeNull();
    expect(normalizeSyncConflict({ ...conflict, entity: "" })).toBeNull();
    expect(normalizeSyncConflict({ ...conflict, entityId: "" })).toBeNull();
  });

  it("unwraps device envelopes", () => {
    const device = { deviceId: "d1", deviceName: "Laptop" };
    expect(normalizeDeviceView(unwrapDevice({ ok: true, value: { device } }))).toMatchObject({
      deviceId: "d1",
    });
    expect(normalizeDeviceView(unwrapDevice({ ok: true, value: device }))).toMatchObject({
      deviceName: "Laptop",
    });
  });
});

describe("renderer: sign-in form validation (PR45)", () => {
  it("accepts a complete form and an identifier-less form", () => {
    expect(validateSignInForm({ displayName: "Ada" })).toEqual({});
    expect(validateSignInForm({ displayName: "Ada", email: "ada@example.com" })).toEqual({});
    expect(isSignInFormValid({ displayName: "Ada" })).toBe(true);
  });

  it("rejects empty and over-long display names", () => {
    expect(validateSignInForm({ displayName: "  " })).toHaveProperty("displayName");
    expect(validateSignInForm({ displayName: "x".repeat(121) })).toHaveProperty("displayName");
    expect(MAX_ACCOUNT_DISPLAY_NAME).toBe(120);
    expect(truncateDisplayName("x".repeat(200))).toHaveLength(121);
    expect(isSignInFormValid({ displayName: "" })).toBe(false);
  });

  it("rejects malformed emails but allows omission", () => {
    expect(validateSignInForm({ displayName: "Ada", email: "not-an-email" })).toHaveProperty(
      "email",
    );
    expect(validateSignInForm({ displayName: "Ada", email: "" })).toEqual({});
    expect(validateSignInForm({ displayName: "Ada" })).toEqual({});
  });

  it("rejects secret-shaped values", () => {
    expect(looksSecretShaped("api_key=sk-live-12345")).toBe(true);
    expect(looksSecretShaped("Ada")).toBe(false);
    expect(validateSignInForm({ displayName: "api_key=sk-live-12345" })).toHaveProperty(
      "displayName",
    );
    expect(isSignInFormValid({ displayName: "password: hunter2" })).toBe(false);
  });

  it("never validates a partial form as executable", () => {
    const errors = validateSignInForm({ displayName: "", email: "bad" });
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    expect(isSignInFormValid({ displayName: "" })).toBe(false);
  });
});

describe("renderer: disconnect-requery through the local stub (PR45)", () => {
  it("returns null bridges without window and empty results without commands", async () => {
    expect(getAccountCommands()).toBeNull();
    expect(getSyncCommands()).toBeNull();
    expect(await fetchAccountSession(null)).toMatchObject({ status: "signed_out" });
    expect(await fetchDevice(null)).toBeNull();
    expect(await fetchSyncStatus(null)).toMatchObject({ status: "idle" });
    expect(await fetchSyncConflicts(null)).toEqual([]);
    await expect(signInAccount(null, { displayName: "Ada" })).resolves.toMatchObject({ ok: false });
    await expect(signOutAccount(null)).resolves.toMatchObject({ ok: false });
    await expect(refreshSession(null)).resolves.toMatchObject({ ok: false });
    await expect(startSync(null)).resolves.toMatchObject({ ok: false });
    await expect(pauseSync(null)).resolves.toMatchObject({ ok: false });
    await expect(resolveConflict(null, "c1", "keep-local")).resolves.toMatchObject({ ok: false });
  });

  it("runs the sign-in/out state machine with validation", async () => {
    const stub = createLocalAccountSyncStub();
    expect(await fetchAccountSession(stub.account)).toMatchObject({ status: "signed_out" });
    await expect(signInAccount(stub.account, { displayName: "" })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      signInAccount(stub.account, { displayName: "api_key=sk-live-1" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      signInAccount(stub.account, { displayName: "Ada", email: "ada@example.com" }),
    ).resolves.toMatchObject({ ok: true });
    const session = await fetchAccountSession(stub.account);
    expect(session).toMatchObject({
      status: "authenticated",
      displayName: "Ada",
      identifier: "ada@example.com",
    });
    const device = await fetchDevice(stub.account);
    expect(device?.deviceName).toBe("This device");
    await expect(refreshSession(stub.account)).resolves.toMatchObject({ ok: true });
    expect(await fetchAccountSession(stub.account)).toMatchObject({ status: "authenticated" });
    await expect(signOutAccount(stub.account)).resolves.toMatchObject({ ok: true });
    expect(await fetchAccountSession(stub.account)).toMatchObject({ status: "signed_out" });
    expect(await fetchDevice(stub.account)).toBeNull();
  });

  it("sign-out preserves local stub data (delete≠wipe)", async () => {
    const stub = createLocalAccountSyncStub({ localProjects: ["proj-A", "proj-B"] });
    await signInAccount(stub.account, { displayName: "Ada" });
    await signOutAccount(stub.account);
    expect(stub.localProjects).toEqual(["proj-A", "proj-B"]);
    expect(await fetchAccountSession(stub.account)).toMatchObject({ status: "signed_out" });
  });

  it("re-queries stub state after remount/disconnect (no renderer truth)", async () => {
    const stub = createLocalAccountSyncStub();
    await signInAccount(stub.account, { displayName: "Ada" });
    const first = await fetchAccountSession(stub.account);
    expect(first.displayName).toBe("Ada");
    // A fresh fetch path sees the same bridge state: remounts recover by re-fetching.
    expect(await fetchAccountSession(stub.account)).toMatchObject({ displayName: "Ada" });
    await signOutAccount(stub.account);
    expect(await fetchAccountSession(stub.account)).toMatchObject({ status: "signed_out" });
  });

  it("toggles sync start/pause and simulates offline/conflict", async () => {
    const stub = createLocalAccountSyncStub();
    await expect(startSync(stub.sync)).resolves.toMatchObject({ ok: true });
    expect((await fetchSyncStatus(stub.sync)).status).toBe("syncing");
    await expect(pauseSync(stub.sync)).resolves.toMatchObject({ ok: true });
    const paused = await fetchSyncStatus(stub.sync);
    expect(paused.status).toBe("idle");
    expect(paused.paused).toBe(true);
    stub.setSyncMode("offline");
    expect((await fetchSyncStatus(stub.sync)).status).toBe("offline");
    await expect(startSync(stub.sync)).resolves.toMatchObject({ ok: false });
    expect(syncNeedsAttention((await fetchSyncStatus(stub.sync)).status)).toBe(true);
  });

  it("lists conflicts and resolves only with explicit choices", async () => {
    const stub = createLocalAccountSyncStub();
    stub.seedConflict({ conflictId: "c1", entity: "memory", entityId: "fact-01" });
    stub.seedConflict({
      conflictId: "c2",
      entity: "profile",
      entityId: "model-pick",
      localVersion: "v1",
      remoteVersion: "v2",
      changedFields: ["modelId", "providerId"],
    });
    const conflicts = await fetchSyncConflicts(stub.sync);
    expect(conflicts.map((c) => c.conflictId).sort()).toEqual(["c1", "c2"]);
    expect((await fetchSyncStatus(stub.sync)).status).toBe("conflict");
    // Silent/auto choices are rejected: only keep-local / keep-remote resolve.
    await expect(resolveConflict(stub.sync, "c1", "auto")).resolves.toMatchObject({ ok: false });
    await expect(resolveConflict(stub.sync, "c1", "keep-active")).resolves.toMatchObject({
      ok: false,
    });
    await expect(resolveConflict(stub.sync, "missing", "keep-local")).resolves.toMatchObject({
      ok: false,
    });
    expect(await fetchSyncConflicts(stub.sync)).toHaveLength(2);
    await expect(resolveConflict(stub.sync, "c1", "keep-local")).resolves.toMatchObject({
      ok: true,
    });
    expect(await fetchSyncConflicts(stub.sync)).toHaveLength(1);
    await expect(resolveConflict(stub.sync, "c2", "keep-remote")).resolves.toMatchObject({
      ok: true,
    });
    expect(await fetchSyncConflicts(stub.sync)).toHaveLength(0);
    expect((await fetchSyncStatus(stub.sync)).status).toBe("idle");
  });

  it("threads what the IPC requires (empty {} payloads + resolution field)", async () => {
    const stub = createLocalAccountSyncStub();
    // Empty commands carry `{}` (never undefined): the main-side Zod
    // schemas validate an object.
    await expect(stub.account.get({})).resolves.toMatchObject({ ok: true });
    await expect(stub.account.signOut({})).resolves.toMatchObject({ ok: true });
    await expect(stub.account.refresh({})).resolves.toMatchObject({ ok: false });
    await expect(stub.sync.status({})).resolves.toMatchObject({ ok: true });
    await expect(stub.sync.start({})).resolves.toMatchObject({ ok: true });
    await expect(stub.sync.pause({})).resolves.toMatchObject({ ok: true });
    await expect(stub.sync.conflicts({})).resolves.toMatchObject({ ok: true });
    // Resolve carries the schema field `resolution` (never `choice`).
    stub.seedConflict({ conflictId: "wire-1" });
    await expect(
      stub.sync.resolve({ conflictId: "wire-1", resolution: "keep-local" }),
    ).resolves.toMatchObject({ ok: true });
    // The `resolveConflict` helper maps the operator choice onto `resolution`.
    stub.seedConflict({ conflictId: "wire-2" });
    await expect(resolveConflict(stub.sync, "wire-2", "keep-remote")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("reports pending and conflict counts from projections", async () => {
    const stub = createLocalAccountSyncStub();
    const status = await fetchSyncStatus(stub.sync);
    expect(pendingSyncCount(status)).toBe(0);
    expect(conflictCount(status)).toBe(0);
    expect(pendingSyncCount(null)).toBe(0);
    expect(conflictCount(null)).toBe(0);
    stub.seedConflict({ conflictId: "c9" });
    expect(conflictCount(await fetchSyncStatus(stub.sync))).toBe(1);
  });
});

describe("renderer: hygiene — truncation, secret redaction, time (PR45)", () => {
  it("redacts assignment-shaped secrets but keeps plain prose", () => {
    expect(redactSecretAssignments("api_key=sk-live-12345")).toBe("api_key: [redacted]");
    expect(redactSecretAssignments("password: hunter2 failed")).toBe("password: [redacted] failed");
    expect(redactSecretAssignments("token limit exceeded, retry later")).toBe(
      "token limit exceeded, retry later",
    );
    expect(truncateText("short", 120)).toBe("short");
  });

  it("formats relative and absolute times safely without throwing", () => {
    expect(formatRelativeTime(undefined)).toBe("—");
    expect(formatRelativeTime("not-a-date")).toBe("—");
    const base = Date.parse("2026-09-18T10:00:00.000Z");
    expect(formatRelativeTime("2026-09-18T09:59:40.000Z", base)).toBe("just now");
    expect(formatRelativeTime("2026-09-18T09:55:00.000Z", base)).toBe("5m ago");
    expect(formatRelativeTime("2026-09-18T07:00:00.000Z", base)).toBe("3h ago");
    expect(formatRelativeTime("2026-09-16T10:00:00.000Z", base)).toBe("2d ago");
    expect(formatAccountTimestamp(undefined)).toBe("—");
    expect(formatAccountTimestamp("not-a-date")).toBe("—");
    expect(formatAccountTimestamp("2026-09-18T10:00:00.000Z")).not.toBe("—");
  });
});

describe("renderer: caps (PR45)", () => {
  it("pins the 50-row render budgets", () => {
    expect(MAX_ACCOUNT_SYNC_ROWS).toBe(50);
    expect(MAX_CONFLICTS_SHOWN).toBe(50);
  });
});

describe("Account surface contract (PR45)", () => {
  it("extends props with the account surface contract", () => {
    const props = read(PROPS);
    expect(props).toContain("AccountSurfaceProps");
    expect(props).toContain("readonly account?: AccountCommands | null");
    expect(props).toContain("readonly sync?: SyncCommands | null");
    expect(props).toContain("syncNeedsAttention?");
  });

  it("renders the signed-out form without executing partial input", () => {
    const component = read(SURFACE);
    expect(component).toContain("Sign in");
    expect(component).toContain("Display name");
    expect(component).toContain("Email (optional)");
    expect(component).toContain("validateSignInForm");
    expect(component).toContain("isSignInFormValid");
    expect(component).toContain("nothing executes from a partial form");
  });

  it("renders the signed-in account, device, and sync status", () => {
    const component = read(SURFACE);
    expect(component).toContain("Device last seen");
    expect(component).toContain("Last sync");
    expect(component).toContain("Pending");
    expect(component).toContain("Conflicts");
    // The surface renders sync state through the canonical helpers (never
    // hardcoded literals): indicator text plus the attention badge class.
    expect(component).toContain("syncStatusIndicator");
    expect(component).toContain("syncStatusBadgeClass");
    expect(component).toContain("Settings");
    // The canonical indicators themselves live in the bridge module and
    // reach the screen via `syncStatusIndicator`: Synced / Syncing… /
    // Offline / Needs attention / Conflict.
    const bridge = read(BRIDGE);
    for (const label of ["Synced", "Syncing…", "Offline", "Needs attention", "Conflict"]) {
      expect(bridge).toContain(label);
    }
  });

  it("signs out with explicit local-preservation messaging", () => {
    const component = read(SURFACE);
    expect(component).toContain("Sign out");
    expect(component).toContain("preserves local projects");
    expect(component).toContain("delete ≠ wipe");
  });

  it("offers start/pause plus explicit conflict resolution only", () => {
    const component = read(SURFACE);
    expect(component).toContain("Start sync");
    expect(component).toContain("Pause");
    expect(component).toContain("Keep local");
    expect(component).toContain("Keep remote");
    expect(component).toContain("never resolved automatically");
    expect(component).not.toMatch(/resolveAutomatically|autoResolve/);
  });

  it("renders conflicts with versions and changed fields", () => {
    const component = read(SURFACE);
    expect(component).toContain("Sync conflicts");
    expect(component).toContain("localVersion");
    expect(component).toContain("remoteVersion");
    expect(component).toContain("changedFields");
  });

  it("re-queries on mount and polls once without renderer-local truth", () => {
    const component = read(SURFACE);
    expect(component).toContain("getAccountCommands");
    expect(component).toContain("getSyncCommands");
    expect(component).toContain("createLocalAccountSyncStub");
    expect(component).toContain("setInterval");
    expect(component).toContain("clearInterval");
    expect(component).toContain("re-queries");
    // Single bounded poll: exactly one setInterval in the surface.
    expect(component.match(/setInterval/g)?.length).toBe(1);
  });

  it("keeps the surface free of privileged imports and raw secrets", () => {
    for (const file of [SURFACE, BRIDGE]) {
      const source = read(file);
      expect(source.includes("dangerouslySetInnerHTML")).toBe(false);
      expect(source).not.toMatch(/from\s+["']electron["']/);
      expect(source).not.toMatch(/from\s+["']node:/);
      expect(source).not.toMatch(/child_process/);
      expect(source).not.toMatch(/@prisma\/client/);
      expect(source).not.toMatch(/accessToken|refreshToken/);
    }
    // The component reaches the bridges only through the workspace module.
    expect(read(SURFACE)).toContain("workspace/account-sync.js");
    expect(read(SURFACE)).not.toMatch(/window\.api\.account\.[a-z]+\(/);
    expect(read(SURFACE)).not.toMatch(/window\.api\.sync\.[a-z]+\(/);
  });

  it("exposes the narrow account/sync bridges with the expected methods", () => {
    const bridge = read(BRIDGE);
    for (const method of ["get", "signIn", "signOut", "refresh", "device"]) {
      expect(bridge).toContain(method);
    }
    for (const method of ["status", "start", "pause", "conflicts", "resolve"]) {
      expect(bridge).toContain(method);
    }
    expect(bridge).toContain("window.api");
    expect(bridge).toContain("?.");
    expect(read(SURFACES)).toContain("account-sync.js");
  });

  it("registers a dedicated account surface without store changes", () => {
    const types = read(TYPES);
    expect(types).toContain("ACCOUNT_SURFACE");
    expect(types).toContain('"account"');
  });

  it("shows the Account entry with a sync-attention dot in the sidebar", () => {
    const sidebar = read(SIDEBAR);
    expect(sidebar).toContain("syncNeedsAttention");
    expect(sidebar).toContain("Account");
  });

  it("renders the Account surface from the workspace main area", () => {
    const main = read(MAIN);
    expect(main).toContain("AccountSurface");
    expect(main).toContain('"account"');
  });
});
