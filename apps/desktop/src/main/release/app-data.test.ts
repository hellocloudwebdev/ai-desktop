// apps/desktop — Application data directory + migration tests.

import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_VERSIONS,
  applyMigrations,
  getVersionsFilePath,
  readVersionsFile,
  resolveAppDataDir,
  runMigrations,
  type VersionsFile,
} from "./app-data.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appdata-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH ?? "" };
}

describe("release: app data", () => {
  it("resolves the override, app name fallback, and versions path", () => {
    expect(resolveAppDataDir({ env: { ...seedEnv(), AI_DESKTOP_DATA_DIR: " /tmp/x " } })).toBe(
      "/tmp/x",
    );
    const fallback = resolveAppDataDir({ appName: "Test App", env: seedEnv() });
    expect(
      fallback.endsWith(path.join(os.tmpdir(), "Test App")) || fallback.endsWith("Test App"),
    ).toBe(true);
    expect(getVersionsFilePath("/data")).toBe(path.join("/data", "versions.json"));
  });

  it("initializes a fresh directory with the current generation", async () => {
    const dataDir = path.join(makeRoot(), "fresh");
    const versions = await runMigrations(dataDir, "1.0.0");
    expect(versions.appVersion).toBe("1.0.0");
    expect(versions.schemaVersion).toBe(CURRENT_VERSIONS.schemaVersion);
    expect(readVersionsFile(dataDir)).toEqual(versions);
    expect(fs.existsSync(path.join(dataDir, "documents"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "databases", ".placeholder"))).toBe(true);
  });

  it("re-runs idempotently without rewriting or re-migrating", async () => {
    const dataDir = path.join(makeRoot(), "idem");
    const first = await runMigrations(dataDir, "1.0.0");
    let migrateCalls = 0;
    const baseline: VersionsFile = { ...first };
    const second = await applyMigrations(dataDir, baseline, [
      {
        version: first.schemaVersion,
        description: "already-applied",
        migrate(): void {
          migrateCalls += 1;
        },
      },
    ]);
    expect(migrateCalls).toBe(0);
    expect(second).toEqual(first);
    expect(readVersionsFile(dataDir)).toEqual(first);
  });

  it("skips already-applied versions and applies pending ones in order", async () => {
    const order: number[] = [];
    const baseline: VersionsFile = {
      appVersion: "1.0.0",
      schemaVersion: 1,
      configVersion: 1,
      workspaceStateVersion: 1,
      syncStateVersion: 1,
    };
    const migrated = await applyMigrations(path.join(makeRoot(), "ordered"), baseline, [
      {
        version: 3,
        description: "third",
        migrate(): void {
          order.push(3);
        },
      },
      {
        version: 2,
        description: "second",
        migrate(): void {
          order.push(2);
        },
      },
      {
        version: 1,
        description: "already applied",
        migrate(): void {
          order.push(1);
        },
      },
    ]);
    expect(order).toEqual([2, 3]);
    expect(migrated.schemaVersion).toBe(3);
  });

  it("failed migrations preserve the prior record and never delete data", async () => {
    const dataDir = path.join(makeRoot(), "failed");
    const prior = await runMigrations(dataDir, "1.0.0");
    const sentinel = path.join(dataDir, "documents", "keep.txt");
    fs.writeFileSync(sentinel, "user data", "utf8");
    let failure: unknown;
    try {
      await applyMigrations(dataDir, prior, [
        {
          version: prior.schemaVersion + 1,
          description: "boom",
          migrate(): void {
            throw new Error("migration exploded");
          },
        },
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(readVersionsFile(dataDir)).toEqual(prior);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("user data");
  });
});
