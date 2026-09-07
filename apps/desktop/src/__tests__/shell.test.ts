import { describe, expect, it } from "vitest";
import { getSecureWebPreferences } from "../main/index.js";
import { desktopApi } from "../preload/index.js";

describe("apps/desktop: Shell Security Invariants & Preload Bridge", () => {
  it("enforces contextIsolation: true and nodeIntegration: false on BrowserWindow", () => {
    const prefs = getSecureWebPreferences("/dummy/path/preload.js");

    // Inviolable constitutional rules (§1.3 & §35.10)
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.preload).toBe("/dummy/path/preload.js");
  });

  it("exposes only a narrow application-owned API on the preload bridge", () => {
    expect(desktopApi).toBeDefined();
    expect(typeof desktopApi.platform).toBe("string");
    expect(typeof desktopApi.isPackaged).toBe("boolean");
    expect(typeof desktopApi.ping).toBe("function");
    expect(desktopApi.ping()).toBe("pong");

    // Must NOT expose raw Electron, Node, or unrestricted objects
    const keys = Object.keys(desktopApi);
    expect(keys).not.toContain("ipcRenderer");
    expect(keys).not.toContain("ipcMain");
    expect(keys).not.toContain("BrowserWindow");
    expect(keys).not.toContain("shell");
    expect(keys).not.toContain("app");
    expect(keys).not.toContain("process");
    expect(keys).not.toContain("fs");
    expect(keys).not.toContain("child_process");
  });
});
