// PR41: apps/desktop — WorkspaceSearchService Tests
//
// Substring/case/whole-word/include matching, line:col detail,
// cancellation, bounds, isolation, and symlink-skip behavior.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceSearchService,
  createSearchCancelledError,
  isSearchCancelledError,
} from "../workspace-search.js";
import { WorkspaceError } from "../workspace-errors.js";

const PROJECT = "proj-search";

let roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-search-"));
  roots.push(root);
  return root;
}

function seed(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "app.ts"),
    "import { helper } from './helper';\nconst greeting = 'Hello World';\nconsole.log(greeting);\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "helper.ts"),
    "export function helper() {\n  return 'hello helper';\n}\n",
  );
  fs.writeFileSync(path.join(root, "notes.txt"), "HELLO in caps\nnothing here\n");
}

function serviceFor(root: string): WorkspaceSearchService {
  return new WorkspaceSearchService({ resolveRoot: (p) => (p === PROJECT ? root : undefined) });
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("apps/desktop: WorkspaceSearchService (PR41)", () => {
  it("finds case-insensitive substring matches with 1-based line/col", () => {
    const root = makeRoot();
    seed(root);
    const outcome = serviceFor(root).search({ projectId: PROJECT, query: "hello" });
    expect(outcome.truncated).toBe(false);
    expect(outcome.searchedFiles).toBe(3);
    const byPath = new Map(outcome.matches.map((m) => [`${m.path}:${m.line}`, m]));
    const hit = byPath.get("src/app.ts:2");
    expect(hit).toBeDefined();
    expect(hit?.column).toBe(19);
    expect(hit?.text).toContain("Hello World");
    expect(byPath.get("notes.txt:1")).toBeDefined();
  });

  it("respects caseSensitive matching", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    const sensitive = svc.search({ projectId: PROJECT, query: "Hello", caseSensitive: true });
    expect(sensitive.matches.map((m) => m.path).sort()).toEqual(["src/app.ts"]);
    const lower = svc.search({ projectId: PROJECT, query: "hello", caseSensitive: true });
    expect(lower.matches.map((m) => m.path).sort()).toEqual(["src/helper.ts"]);
  });

  it("matches whole words only when requested", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "w.txt"), "helloworld hello hell\n");
    const svc = serviceFor(root);
    const loose = svc.search({ projectId: PROJECT, query: "hello" });
    expect(loose.matches).toHaveLength(1);
    const strict = svc.search({ projectId: PROJECT, query: "hello", wholeWord: true });
    expect(strict.matches).toHaveLength(1);
    expect(strict.matches[0]?.column).toBe(12);
  });

  it("filters by include path substring", () => {
    const root = makeRoot();
    seed(root);
    const outcome = serviceFor(root).search({
      projectId: PROJECT,
      query: "hello",
      include: "helper",
    });
    expect(outcome.matches.length).toBeGreaterThan(0);
    for (const match of outcome.matches) {
      expect(match.path).toContain("helper");
    }
  });

  it("scopes search to a subdirectory path", () => {
    const root = makeRoot();
    seed(root);
    const outcome = serviceFor(root).search({ projectId: PROJECT, path: "src", query: "hello" });
    expect(outcome.matches.length).toBeGreaterThan(0);
    for (const match of outcome.matches) {
      expect(match.path.startsWith("src/")).toBe(true);
    }
  });

  it("searches a single file start path", () => {
    const root = makeRoot();
    seed(root);
    const outcome = serviceFor(root).search({
      projectId: PROJECT,
      path: "notes.txt",
      query: "caps",
    });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]).toMatchObject({ path: "notes.txt", line: 1, column: 10 });
  });

  it("truncates at maxResults and reports searchedFiles", () => {
    const root = makeRoot();
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), "needle\nneedle\nneedle\n");
    }
    const outcome = serviceFor(root).search({ projectId: PROJECT, query: "needle", maxResults: 5 });
    expect(outcome.matches).toHaveLength(5);
    expect(outcome.truncated).toBe(true);
    expect(outcome.searchedFiles).toBeGreaterThan(0);
  });

  it("throws a canonical AbortError when already aborted", () => {
    const root = makeRoot();
    seed(root);
    const controller = new AbortController();
    controller.abort();
    try {
      serviceFor(root).search({ projectId: PROJECT, query: "hello", signal: controller.signal });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect(isSearchCancelledError(err)).toBe(true);
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("createSearchCancelledError round-trips through the guard", () => {
    expect(isSearchCancelledError(createSearchCancelledError())).toBe(true);
    expect(isSearchCancelledError(new Error("cancelled"))).toBe(false);
    expect(isSearchCancelledError(new WorkspaceError("INVALID", "x"))).toBe(false);
  });

  it("skips node_modules/.git, symlinked dirs, and binary/oversized files", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "smuggled.txt"), "uniquesearchterm\n");
    const root = makeRoot();
    seed(root);
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "i.js"), "uniquesearchterm\n");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "uniquesearchterm\n");
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x68, 0x00, 0x69]));
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(300 * 1024));
    const outcome = serviceFor(root).search({ projectId: PROJECT, query: "uniquesearchterm" });
    expect(outcome.matches).toEqual([]);
  });

  it("rejects empty/oversized queries and invalid maxResults", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    expect(() => svc.search({ projectId: PROJECT, query: "" })).toThrow(WorkspaceError);
    expect(() => svc.search({ projectId: PROJECT, query: "x".repeat(201) })).toThrow(
      WorkspaceError,
    );
    expect(() => svc.search({ projectId: PROJECT, query: "hi", maxResults: 0 })).toThrow(
      WorkspaceError,
    );
    expect(() => svc.search({ projectId: PROJECT, query: "hi", maxResults: 999 })).not.toThrow();
  });

  it("rejects outside paths and unknown projects", () => {
    const root = makeRoot();
    seed(root);
    const svc = serviceFor(root);
    try {
      svc.search({ projectId: PROJECT, query: "hi", path: ".." });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect((err as WorkspaceError).workspaceCode).toBe("OUTSIDE_WORKSPACE");
    }
    try {
      svc.search({ projectId: "nope", query: "hi" });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expect((err as WorkspaceError).workspaceCode).toBe("NO_WORKSPACE");
    }
  });

  it("isolates projects onto their own roots", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    fs.writeFileSync(path.join(rootA, "a.txt"), "isolationmarker\n");
    const svc = new WorkspaceSearchService({
      resolveRoot: (p) => (p === "pa" ? rootA : p === "pb" ? rootB : undefined),
    });
    expect(svc.search({ projectId: "pb", query: "isolationmarker" }).matches).toEqual([]);
    expect(svc.search({ projectId: "pa", query: "isolationmarker" }).matches).toHaveLength(1);
  });

  it("grouping: multiple hits in one file report distinct line/col", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "multi.txt"), "aa bb aa\ncc aa\n");
    const outcome = serviceFor(root).search({ projectId: PROJECT, query: "aa" });
    expect(outcome.matches).toHaveLength(2);
    expect(outcome.matches[0]).toMatchObject({ path: "multi.txt", line: 1, column: 1 });
    expect(outcome.matches[1]).toMatchObject({ path: "multi.txt", line: 2, column: 4 });
  });

  it("returns empty matches (not an error) when nothing matches", () => {
    const root = makeRoot();
    seed(root);
    const outcome = serviceFor(root).search({ projectId: PROJECT, query: "zzz-no-match" });
    expect(outcome).toEqual({ matches: [], truncated: false, searchedFiles: 3 });
  });
});
