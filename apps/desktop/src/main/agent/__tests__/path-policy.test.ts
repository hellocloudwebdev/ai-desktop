// PR30.4: apps/desktop — Workspace Path Policy Tests

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathPolicyError, resolveWorkspacePath } from "../filesystem/path-policy.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ws-"));
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("apps/desktop: Workspace path policy (PR30.4)", () => {
  it("resolves nested valid paths inside the workspace", () => {
    const resolved = resolveWorkspacePath(root, "src/nested");
    expect(resolved.relative).toBe("src/nested");
    expect(resolved.targetReal.startsWith(resolved.workspaceRootReal)).toBe(true);
  });

  it("resolves the workspace root itself", () => {
    const resolved = resolveWorkspacePath(root, ".");
    expect(resolved.relative).toBe(".");
    expect(resolved.targetReal).toBe(resolved.workspaceRootReal);
  });

  it("rejects parent traversal outside the workspace", () => {
    expect(() => resolveWorkspacePath(root, "../../outside")).toThrow(PathPolicyError);
    expect(() => resolveWorkspacePath(root, "src/../../../etc")).toThrow(PathPolicyError);
  });

  it("rejects absolute paths outside the workspace", () => {
    const outside = path.resolve(root, "..");
    expect(() => resolveWorkspacePath(root, outside)).toThrow(PathPolicyError);
  });

  it("resolves absolute paths inside the workspace", () => {
    const inside = path.join(root, "src", "a.ts");
    const resolved = resolveWorkspacePath(root, inside);
    expect(resolved.relative).toBe("src/a.ts");
  });

  it("resolves not-yet-existing write targets through the nearest ancestor", () => {
    const resolved = resolveWorkspacePath(root, "src/new/deep/file.ts");
    expect(resolved.relative).toBe("src/new/deep/file.ts");
  });

  it("rejects not-yet-existing targets outside the workspace", () => {
    expect(() => resolveWorkspacePath(root, "../escape/new-file.ts")).toThrow(PathPolicyError);
  });

  it("rejects symlink escapes pointing outside the workspace", () => {
    if (process.platform === "win32") return; // symlink privileges vary on Windows CI
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-out-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
      fs.symlinkSync(outsideDir, path.join(root, "evil-link"));
      expect(() => resolveWorkspacePath(root, "evil-link/secret.txt")).toThrow(PathPolicyError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects empty paths and NUL bytes", () => {
    expect(() => resolveWorkspacePath(root, "")).toThrow(PathPolicyError);
    expect(() => resolveWorkspacePath(root, "a\0b")).toThrow(PathPolicyError);
  });

  it("rejects a missing workspace root", () => {
    expect(() => resolveWorkspacePath(path.join(root, "nope"), "a")).toThrow(PathPolicyError);
  });
});
