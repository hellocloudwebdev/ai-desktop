// PR47: apps/desktop — Update IPC suite (channels, delegation, redaction).

import { describe, expect, it, vi } from "vitest";
import { createUpdateIpcHandlers, UPDATE_IPC_CHANNELS } from "./update-ipc.js";
import { SecureUpdateService } from "./update-service.js";

const FEED_URL =
  "https://github.com/hellocloudwebdev/ai-desktop/releases/latest/download/update-win32-x64.json";

function makeService(state: "up-to-date" | "available" = "up-to-date"): SecureUpdateService {
  return new SecureUpdateService({
    feedUrl: FEED_URL,
    channel: "stable",
    currentVersion: "1.0.0",
    autoUpdater: {
      checkForUpdates: async () =>
        state === "available"
          ? {
              version: "1.1.0",
              artifactUrl: "https://github.com/acme/app/releases/download/v1.1.0/app.exe",
              channel: "stable",
            }
          : null,
      downloadUpdate: async () => "/tmp/app.exe",
      quitAndInstall: () => undefined,
    },
    emit: () => undefined,
  });
}

function handlerFor(service: SecureUpdateService, channel: string) {
  const handlers = createUpdateIpcHandlers(service);
  const found = handlers.find((h) => h.channel === channel);
  if (!found) {
    throw new Error(`missing handler for ${channel}`);
  }
  return found;
}

describe("UPDATE_IPC_CHANNELS", () => {
  it("uses the canonical channel names", () => {
    expect(UPDATE_IPC_CHANNELS.CHECK).toBe("updates:check");
    expect(UPDATE_IPC_CHANNELS.DOWNLOAD).toBe("updates:download");
    expect(UPDATE_IPC_CHANNELS.INSTALL).toBe("updates:install");
    expect(UPDATE_IPC_CHANNELS.STATE).toBe("updates:state");
  });

  it("exposes one descriptor per channel", () => {
    const channels = createUpdateIpcHandlers(makeService()).map((h) => h.channel);
    expect(channels).toEqual([
      "updates:check",
      "updates:download",
      "updates:install",
      "updates:state",
    ]);
  });
});

describe("update IPC handlers", () => {
  it("check delegates to the service and reports state", async () => {
    const service = makeService("available");
    const res = await handlerFor(service, "updates:check").handler({});
    expect(res.state).toBe("available");
    expect(res.version).toBe("1.1.0");
  });

  it("state reports the current snapshot without invoking the adapter", async () => {
    const checkForUpdates = vi.fn(async () => null);
    const service = new SecureUpdateService({
      feedUrl: FEED_URL,
      channel: "stable",
      currentVersion: "1.0.0",
      autoUpdater: {
        checkForUpdates,
        downloadUpdate: async () => "/tmp/app.exe",
        quitAndInstall: () => undefined,
      },
      emit: () => undefined,
    });
    const res = await handlerFor(service, "updates:state").handler({});
    expect(res.state).toBe("idle");
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("redacts secret material from check errors", async () => {
    const service = new SecureUpdateService({
      feedUrl: FEED_URL,
      channel: "stable",
      currentVersion: "1.0.0",
      autoUpdater: {
        checkForUpdates: async () => {
          throw new Error("feed failed; apiKey=super-secret-value");
        },
        downloadUpdate: async () => "/tmp/app.exe",
        quitAndInstall: () => undefined,
      },
      emit: () => undefined,
    });
    const res = await handlerFor(service, "updates:check").handler({});
    expect(res.state).toBe("failed");
    expect(String(res.error)).not.toContain("super-secret-value");
  });

  it("download surfaces a safe error when nothing is available", async () => {
    const service = makeService("up-to-date");
    const res = await handlerFor(service, "updates:download").handler({});
    expect(res.state).toBe("failed");
    expect(res.error).toBeTruthy();
  });
});
