// PR30.5/30.6: apps/desktop — Filesystem Backend Tests

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_READ_BYTES,
  isFilesystemError,
  listDirectory,
  readFile,
  searchWorkspace,
  writeFile,
} from "../filesystem/filesystem-tool-backend.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-fs-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Sample\n");
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "needle-haystack\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("apps/desktop: Filesystem backend (PR30.5–30.6)", () => {
  it("lists directories with sorted entries", () => {
    const result = listDirectory(root, ".");
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(result.entries.map((e) => e.name)).toEqual(["node_modules", "README.md", "src"]);
    expect(result.entries.find((e) => e.name === "src")?.kind).toBe("directory");
  });

  it("rejects listing outside the workspace", () => {
    const result = listDirectory(root, "../outside");
    expect(isFilesystemError(result)).toBe(true);
  });

  it("reads files with line windows and totals", () => {
    const result = readFile(root, "src/a.ts", 2, 2);
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(result.content).toBe("const b = 2;");
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects reads outside the workspace", () => {
    const result = readFile(root, "../../etc/passwd");
    expect(isFilesystemError(result)).toBe(true);
  });

  it("rejects invalid line ranges", () => {
    const result = readFile(root, "src/a.ts", 9, 3);
    expect(isFilesystemError(result)).toBe(true);
  });

  it("truncates oversized reads to the byte ceiling", () => {
    const big = `x = "${"y".repeat(1000)}"\n`.repeat(200);
    fs.writeFileSync(path.join(root, "src", "big.ts"), big);
    const result = readFile(root, "src/big.ts");
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("writes files and creates parent directories", () => {
    const result = writeFile(root, "src/new/out.ts", "export const x = 1;\n");
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(result.created).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "new", "out.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });

  it("rejects writes outside the workspace", () => {
    const result = writeFile(root, "../evil.ts", "bad");
    expect(isFilesystemError(result)).toBe(true);
  });

  it("rejects oversized writes", () => {
    const result = writeFile(root, "src/huge.ts", "z".repeat(200 * 1024));
    expect(isFilesystemError(result)).toBe(true);
    if (!isFilesystemError(result)) return;
    expect(result.code).toBe("WRITE_TOO_LARGE");
  });

  it("searches file names and text deterministically", () => {
    const result = searchWorkspace(root, ".", "const a");
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].path).toBe("src/a.ts");
    expect(result.matches[0].line).toBe(1);
  });

  it("excludes dependency directories from search", () => {
    const result = searchWorkspace(root, ".", "needle-haystack");
    expect(isFilesystemError(result)).toBe(false);
    if (isFilesystemError(result)) return;
    expect(result.matches).toHaveLength(0);
  });

  it("rejects empty search queries", () => {
    const result = searchWorkspace(root, ".", "  ");
    expect(isFilesystemError(result)).toBe(true);
  });
});
