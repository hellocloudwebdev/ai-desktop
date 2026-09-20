// apps/desktop — First-run initialization tests.

import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeFirstRun } from "./first-run.js";
import { readVersionsFile } from "./app-data.js";

const roots: string[] = [];

function makeDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firstrun-"));
  roots.push(root);
  return path.join(root, "data");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("release: first run", () => {
  it("reports firstRun true on first launch and creates all directories", async () => {
    const dataDir = makeDataDir();
    const result = await initializeFirstRun(dataDir, { appVersion: "1.0.0" });
    expect(result.firstRun).toBe(true);
    expect(result.dataDir).toBe(dataDir);
    for (const subdir of ["documents", "skills", "extensions", "backups", "logs"]) {
      expect(fs.existsSync(path.join(dataDir, subdir))).toBe(true);
    }
    expect(readVersionsFile(dataDir)?.appVersion).toBe("1.0.0");
  });

  it("reports firstRun false on the second launch", async () => {
    const dataDir = makeDataDir();
    const first = await initializeFirstRun(dataDir, { appVersion: "1.0.0" });
    const second = await initializeFirstRun(dataDir, { appVersion: "1.0.0" });
    expect(first.firstRun).toBe(true);
    expect(second.firstRun).toBe(false);
    expect(second.dataDir).toBe(dataDir);
  });

  it("bumps the recorded app version across releases", async () => {
    const dataDir = makeDataDir();
    await initializeFirstRun(dataDir, { appVersion: "1.0.0" });
    await initializeFirstRun(dataDir, { appVersion: "1.1.0" });
    expect(readVersionsFile(dataDir)?.appVersion).toBe("1.1.0");
  });

  it("performs no network or plugin side effects (filesystem only)", async () => {
    const source = fs.readFileSync(new URL("./first-run.ts", import.meta.url), "utf8");
    for (const marker of [
      "fetch(",
      "axios",
      "http.request",
      "enablePlugin",
      "installPlugin",
      "upload",
    ]) {
      expect(source, marker).not.toContain(marker);
    }
    const dataDir = makeDataDir();
    const result = await initializeFirstRun(dataDir, { appVersion: "1.0.0" });
    expect(result.firstRun).toBe(true);
  });
});
