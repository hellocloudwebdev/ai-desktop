// PR41: apps/desktop — WorkspaceFileService Tests
//
// Happy paths, traversal/absolute/symlink escapes, binary detection,
// external-modification conflicts, and project isolation.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceFileService } from "../workspace-files.js";
import { WorkspaceError } from "../workspace-errors.js";

const PROJECT = "proj-files";

let roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-files-"));
  roots.push(root);
  return root;
}

function seed(root: string): void {
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(path.join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# hello\n");
}

function serviceFor(root: string): WorkspaceFileService {
  return new WorkspaceFileService({ resolveRoot: (p) => (p === PROJECT ? root : undefined) });
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function expectWorkspaceError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).workspaceCode).toBe(code);
    return;
  }
  throw new Error(`Expected WorkspaceError ${code}`);
}

describe("apps/desktop: WorkspaceFileService (PR41)", () => {
  it("lists the tree with relative posix paths and sizes", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const result = svc.listTree({ projectId: PROJECT, depth: 3 });
    expect(result.path).toBe(".");
    expect(result.truncated).toBe(false);
    const byPath = new Map(result.entries.map((e) => [e.path, e]));
    expect(byPath.get("src")?.kind).toBe("directory");
    expect(byPath.get("src/a.ts")?.kind).toBe("file");
    expect(byPath.get("src/a.ts")?.size).toBeGreaterThan(0);
    expect(byPath.get("src/nested/b.ts")?.kind).toBe("file");
    expect(byPath.get("README.md")?.kind).toBe("file");
  });

  it("caps list depth at 4 even when depth is larger", () => {
    const root = makeRoot();
    let cursor = root;
    for (let i = 0; i < 7; i++) {
      cursor = path.join(cursor, `d${i}`);
      fs.mkdirSync(cursor, { recursive: true });
    }
    fs.writeFileSync(path.join(cursor, "deep.txt"), "x\n");
    const svc = serviceFor(root);
    const result = svc.listTree({ projectId: PROJECT, depth: 99 });
    const depths = result.entries.map((e) => e.path.split("/").length);
    expect(Math.max(...depths)).toBeLessThanOrEqual(4);
  });

  it("depth 0 returns no entries", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expect(svc.listTree({ projectId: PROJECT, depth: 0 }).entries).toEqual([]);
  });

  it("reads a file with line windows and mtimeMs", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const full = svc.readFile({ projectId: PROJECT, path: "src/a.ts" });
    expect(full.content).toContain("const a = 1;");
    expect(full.truncated).toBe(false);
    expect(full.totalLines).toBe(3);
    expect(typeof full.mtimeMs).toBe("number");
    const window = svc.readFile({ projectId: PROJECT, path: "src/a.ts", startLine: 2, endLine: 2 });
    expect(window.content).toBe("const b = 2;");
    expect(window.truncated).toBe(true);
  });

  it("writes a file and reports created + mtimeMs", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const first = svc.writeFile({ projectId: PROJECT, path: "new.txt", content: "hello" });
    expect(first.created).toBe(true);
    expect(first.bytesWritten).toBe(5);
    expect(first.mtimeMs).toBeGreaterThan(0);
    const second = svc.writeFile({ projectId: PROJECT, path: "new.txt", content: "hello!" });
    expect(second.created).toBe(false);
  });

  it("writes with a matching expectedMtimeMs", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const read = svc.readFile({ projectId: PROJECT, path: "src/a.ts" });
    const written = svc.writeFile({
      projectId: PROJECT,
      path: "src/a.ts",
      content: "const a = 10;\n",
      expectedMtimeMs: read.mtimeMs,
    });
    expect(written.created).toBe(false);
  });

  it("rejects writes with a stale expectedMtimeMs (EXTERNAL_MODIFIED)", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const read = svc.readFile({ projectId: PROJECT, path: "src/a.ts" });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "externally changed\n");
    expectWorkspaceError(
      () =>
        svc.writeFile({
          projectId: PROJECT,
          path: "src/a.ts",
          content: "stale\n",
          expectedMtimeMs: read.mtimeMs,
        }),
      "EXTERNAL_MODIFIED",
    );
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("externally changed\n");
  });

  it("rejects binary files with BINARY_FILE (NUL in first 8KB)", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x41, 0x42, 0x00, 0x43]));
    const svc = serviceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "blob.bin" }),
      "BINARY_FILE",
    );
  });

  it("creates files (missing parents) and refuses existing paths", () => {
    const root = makeRoot();
    const svc = serviceFor(root);
    const created = svc.createFile({ projectId: PROJECT, path: "a/b/c.txt", content: "hi" });
    expect(created.path).toBe("a/b/c.txt");
    expect(created.bytesWritten).toBe(2);
    expectWorkspaceError(
      () => svc.createFile({ projectId: PROJECT, path: "a/b/c.txt", content: "hi" }),
      "INVALID",
    );
  });

  it("creates directories recursively", () => {
    const root = makeRoot();
    const svc = serviceFor(root);
    const result = svc.createDirectory({ projectId: PROJECT, path: "x/y" });
    expect(result).toEqual({ path: "x/y", created: true });
    expect(fs.statSync(path.join(root, "x", "y")).isDirectory()).toBe(true);
  });

  it("renames within the workspace and reports relative from/to", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const result = svc.rename({ projectId: PROJECT, from: "src/a.ts", to: "src/renamed.ts" });
    expect(result).toEqual({ from: "src/a.ts", to: "src/renamed.ts" });
    expect(fs.existsSync(path.join(root, "src", "a.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "renamed.ts"))).toBe(true);
  });

  it("rejects rename destinations outside the workspace", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(
      () => svc.rename({ projectId: PROJECT, from: "src/a.ts", to: "../escape.ts" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("rejects rename onto an existing destination", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(
      () => svc.rename({ projectId: PROJECT, from: "src/a.ts", to: "README.md" }),
      "INVALID",
    );
  });

  it("deletes files and recursive directories", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const file = svc.delete({ projectId: PROJECT, path: "README.md" });
    expect(file).toEqual({ path: "README.md", deleted: true, entriesRemoved: 1 });
    const dir = svc.delete({ projectId: PROJECT, path: "src" });
    expect(dir.deleted).toBe(true);
    expect(dir.entriesRemoved).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(root, "src"))).toBe(false);
  });

  it("refuses to delete the workspace root", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(() => svc.delete({ projectId: PROJECT, path: "." }), "INVALID");
  });

  it("rejects delete escapes outside the workspace", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(() => svc.delete({ projectId: PROJECT, path: ".." }), "OUTSIDE_WORKSPACE");
  });

  it("reports NOT_FOUND for missing paths", () => {
    const root = makeRoot();
    const svc = serviceFor(root);
    expectWorkspaceError(() => svc.readFile({ projectId: PROJECT, path: "nope.ts" }), "NOT_FOUND");
    expectWorkspaceError(
      () => svc.rename({ projectId: PROJECT, from: "nope.ts", to: "x.ts" }),
      "NOT_FOUND",
    );
    expectWorkspaceError(() => svc.delete({ projectId: PROJECT, path: "nope.ts" }), "NOT_FOUND");
  });

  it("getStatus reports exists/kind/size/mtimeMs for conflict polling", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const file = svc.getStatus({ projectId: PROJECT, path: "src/a.ts" });
    expect(file.exists).toBe(true);
    expect(file.kind).toBe("file");
    expect(file.size).toBeGreaterThan(0);
    expect(typeof file.mtimeMs).toBe("number");
    const dir = svc.getStatus({ projectId: PROJECT, path: "src" });
    expect(dir).toMatchObject({ exists: true, kind: "directory" });
    expect(svc.getStatus({ projectId: PROJECT, path: "missing.ts" })).toEqual({ exists: false });
  });

  it("rejects parent traversal and absolute outside paths", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "../../outside" }),
      "OUTSIDE_WORKSPACE",
    );
    expectWorkspaceError(
      () => svc.listTree({ projectId: PROJECT, path: path.resolve(root, "..") }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("skips symlinked dirs in listTree and rejects escaping symlink reads", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const root = makeRoot();
    seed(root);
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"), "file");
    const svc = serviceFor(root);
    const listed = svc.listTree({ projectId: PROJECT });
    const paths = listed.entries.map((e) => e.path);
    expect(paths).not.toContain("linked");
    expect(paths).not.toContain("linked/secret.txt");
    expect(paths).not.toContain("leak.txt");
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "leak.txt" }),
      "SYMLINK_ESCAPE",
    );
  });

  it("uses only targetReal: a nested symlink inside a listed dir cannot be followed", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "evil.txt"), "evil\n");
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "ok.txt"), "ok\n");
    fs.symlinkSync(path.join(outside, "evil.txt"), path.join(root, "sub", "evil.txt"), "file");
    const svc = serviceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "sub/evil.txt" }),
      "SYMLINK_ESCAPE",
    );
  });

  it("fails closed for unregistered projects", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(() => svc.listTree({ projectId: "unknown" }), "NO_WORKSPACE");
    expectWorkspaceError(
      () => svc.readFile({ projectId: "unknown", path: "src/a.ts" }),
      "NO_WORKSPACE",
    );
    expectWorkspaceError(
      () => svc.writeFile({ projectId: "unknown", path: "x", content: "y" }),
      "NO_WORKSPACE",
    );
  });

  it("isolates projects: a second root cannot see the first", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    fs.writeFileSync(path.join(rootA, "only-a.txt"), "a\n");
    const svc = new WorkspaceFileService({
      resolveRoot: (p) => (p === "proj-a" ? rootA : p === "proj-b" ? rootB : undefined),
    });
    expectWorkspaceError(
      () => svc.readFile({ projectId: "proj-b", path: "only-a.txt" }),
      "NOT_FOUND",
    );
    expect(svc.readFile({ projectId: "proj-a", path: "only-a.txt" }).content).toBe("a\n");
  });

  it("rejects IS_DIRECTORY reads and empty/invalid input", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expectWorkspaceError(() => svc.readFile({ projectId: PROJECT, path: "src" }), "IS_DIRECTORY");
    expectWorkspaceError(() => svc.readFile({ projectId: PROJECT, path: "" }), "INVALID");
    expectWorkspaceError(() => svc.listTree({ projectId: PROJECT, depth: -1 }), "INVALID");
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "src/a.ts", maxBytes: 0 }),
      "INVALID",
    );
  });

  it("errors never leak absolute main-side paths", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    try {
      svc.readFile({ projectId: PROJECT, path: "../../nope" });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as Error).message).not.toContain(root);
      expect((err as Error).message).not.toContain(os.tmpdir());
    }
  });
});
