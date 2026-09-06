import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("StorageDatabase: SQLite WAL Initialization and Verification", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-wal-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    // Copy template dev.db created by prisma migrate dev to preserve schema
    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
  });

  afterAll(async () => {
    await db.close();
    try {
      const dir = path.dirname(tmpDbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });

  it("actively enables and verifies SQLite WAL mode at runtime", async () => {
    expect(db.isInitialized).toBe(true);

    const mode = await db.getJournalMode();
    expect(mode).toBe("wal");
  });

  it("executes standard PRAGMA queries without error", async () => {
    const rows =
      await db.client.$queryRawUnsafe<Array<{ synchronous: number }>>("PRAGMA synchronous;");
    expect(rows).toBeDefined();
    expect(rows.length).toBeGreaterThan(0);
  });
});
