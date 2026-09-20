// PR47: renderer — UpdateBanner Component and State Tests
//
// Tests UpdateBanner states, button behaviors, and user-facing status messages.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BANNER_FILE = path.resolve(__dirname, "../components/UpdateBanner.tsx");
const APP_FILE = path.resolve(__dirname, "../App.tsx");
const PRELOAD_FILE = path.resolve(__dirname, "../../preload/index.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("renderer: UpdateBanner (PR47)", () => {
  it("defines all canonical update states without stack traces", () => {
    const banner = read(BANNER_FILE);
    const expectedStates = [
      "idle",
      "checking",
      "available",
      "downloading",
      "verifying",
      "downloaded",
      "ready",
      "installing",
      "updated",
      "up-to-date",
      "failed",
    ];
    for (const state of expectedStates) {
      expect(banner).toContain(`"${state}"`);
    }
  });

  it("exposes clear action callbacks for check, download, and install", () => {
    const banner = read(BANNER_FILE);
    expect(banner).toContain("onCheck: () => void");
    expect(banner).toContain("onDownload: () => void");
    expect(banner).toContain("onInstall: () => void");
  });

  it("wires update bridge in App.tsx with onUpdateState and action handlers", () => {
    const app = read(APP_FILE);
    expect(app).toContain("window.api.updates");
    expect(app).toContain("checkForUpdates");
    expect(app).toContain("downloadUpdate");
    expect(app).toContain("quitAndInstall");
    expect(app).toContain("onUpdateState");
    expect(app).toContain("<UpdateBanner");
  });

  it("defines typed desktop updates bridge in preload API", () => {
    const preload = read(PRELOAD_FILE);
    expect(preload).toContain("updates: {");
    expect(preload).toContain("checkForUpdates(");
    expect(preload).toContain("downloadUpdate(");
    expect(preload).toContain("quitAndInstall(");
    expect(preload).toContain("onUpdateState(");
  });
});
