// PR47: apps/desktop — SecureUpdateService suite (fake adapter, fail-closed).

import { describe, expect, it, vi } from "vitest";
import {
  enforceUpdateSecurity,
  SecureUpdateService,
  UPDATE_SECURITY_INVARIANTS,
  type UpdateAutoUpdaterAdapter,
  type UpdateCheckResult,
} from "./update-service.js";

const FEED_URL =
  "https://github.com/hellocloudwebdev/ai-desktop/releases/latest/download/update-win32-x64.json";

function makeService(adapter: Partial<UpdateAutoUpdaterAdapter>) {
  const emit = vi.fn();
  const service = new SecureUpdateService({
    feedUrl: FEED_URL,
    channel: "stable",
    currentVersion: "1.0.0",
    autoUpdater: {
      checkForUpdates: adapter.checkForUpdates ?? (async () => null),
      downloadUpdate: adapter.downloadUpdate ?? (async () => "/tmp/app.exe"),
      quitAndInstall: adapter.quitAndInstall ?? (() => undefined),
    },
    emit,
  });
  return { service, emit };
}

function candidate(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    version: "1.1.0",
    artifactUrl: "https://github.com/acme/app/releases/download/v1.1.0/app.exe",
    sha256: "c".repeat(64),
    channel: "stable",
    ...overrides,
  };
}

describe("SecureUpdateService", () => {
  it("reports up-to-date when the adapter returns null", async () => {
    const { service } = makeService({ checkForUpdates: async () => null });
    expect(await service.checkForUpdates()).toBe("up-to-date");
    expect(service.getState()).toBe("up-to-date");
  });

  it("reports available for a newer well-formed candidate", async () => {
    const { service } = makeService({ checkForUpdates: async () => candidate() });
    expect(await service.checkForUpdates()).toBe("available");
    expect(service.getSnapshot().version).toBe("1.1.0");
  });

  it("rejects downgrades as failed (recoverable)", async () => {
    const { service } = makeService({
      checkForUpdates: async () => candidate({ version: "0.9.0" }),
    });
    const state = await service.checkForUpdates();
    expect(state).toBe("failed");
    expect(service.getSnapshot().recoverable).toBe(true);
    expect(service.getSnapshot().error).toBeTruthy();
  });

  it("fails closed on checksum mismatch", async () => {
    const failing = new SecureUpdateService({
      feedUrl: FEED_URL,
      channel: "stable",
      currentVersion: "1.0.0",
      autoUpdater: {
        checkForUpdates: async () => candidate(),
        downloadUpdate: async () => "/tmp/app.exe",
        quitAndInstall: () => undefined,
      },
      emit: () => undefined,
      hashFile: async () => false,
    });
    expect(await failing.checkForUpdates()).toBe("available");
    await expect(failing.downloadUpdate()).rejects.toThrow(/checksum/i);
    expect(failing.getState()).toBe("failed");
  });

  it("gates quitAndInstall until the update is ready", async () => {
    const { service } = makeService({ checkForUpdates: async () => candidate() });
    await service.checkForUpdates();
    await expect(service.quitAndInstall()).rejects.toThrow(/not ready/i);
  });

  it("installs after a verified download", async () => {
    const quitAndInstall = vi.fn();
    const svc = new SecureUpdateService({
      feedUrl: FEED_URL,
      channel: "stable",
      currentVersion: "1.0.0",
      autoUpdater: {
        checkForUpdates: async () => candidate({ sha256: undefined }),
        downloadUpdate: async () => "/tmp/app.exe",
        quitAndInstall,
      },
      emit: () => undefined,
    });
    expect(await svc.checkForUpdates()).toBe("available");
    expect(await svc.downloadUpdate()).toBe("/tmp/app.exe");
    await svc.quitAndInstall();
    expect(svc.getState()).toBe("updated");
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe("enforceUpdateSecurity", () => {
  it("pins the invariant list", () => {
    expect(UPDATE_SECURITY_INVARIANTS).toContain("permission-manager-enabled");
    expect(UPDATE_SECURITY_INVARIANTS).toContain("no-silent-plugin-install");
  });

  it("throws on forbidden metadata keys", () => {
    expect(() => enforceUpdateSecurity({ silentPluginInstall: true })).toThrow();
    expect(() => enforceUpdateSecurity({ nested: { evalPayload: "x" } })).toThrow();
    expect(() => enforceUpdateSecurity({ version: "1.0.0" })).not.toThrow();
  });
});
