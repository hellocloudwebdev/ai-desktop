// PR41: apps/desktop — Workspace Diff Tests
//
// Add/del/context hunks, empty/identical inputs, truncation, determinism,
// and unified-string rendering.

import { describe, expect, it } from "vitest";
import {
  DIFF_MAX_CELLS,
  computeUnifiedDiff,
  diffLines,
  toUnifiedString,
} from "../workspace-diff.js";

describe("apps/desktop: workspace diff (PR41)", () => {
  it("produces an add hunk with context lines", () => {
    const diff = computeUnifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nNEW\nd\ne\nf\ng\n", "f.ts");
    expect(diff.truncated).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk).toBeDefined();
    expect(hunk?.lines.map((l) => l.kind)).toEqual([
      "context",
      "context",
      "context",
      "add",
      "context",
      "context",
      "context",
    ]);
    expect(hunk?.oldLines).toBe(6);
    expect(hunk?.newLines).toBe(7);
  });

  it("produces a del hunk", () => {
    const diff = computeUnifiedDiff("a\nGONE\nb\n", "a\nb\n");
    expect(diff.hunks).toHaveLength(1);
    // Trailing newlines yield a trailing empty context line on both sides.
    expect(diff.hunks[0]?.lines.map((l) => l.kind)).toEqual([
      "context",
      "del",
      "context",
      "context",
    ]);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 3 });
  });

  it("splits distant changes into separate hunks", () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const next = oldText.replace("line2", "CHANGED2").replace("line25", "CHANGED25");
    const diff = computeUnifiedDiff(oldText, next);
    expect(diff.hunks).toHaveLength(2);
  });

  it("returns no hunks for identical input", () => {
    const diff = computeUnifiedDiff("a\nb\n", "a\nb\n");
    expect(diff.hunks).toEqual([]);
    expect(diff.truncated).toBe(false);
  });

  it("handles empty old and new text", () => {
    expect(computeUnifiedDiff("", "").hunks).toEqual([]);
    const added = computeUnifiedDiff("", "a\nb\n");
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]?.lines.every((l) => l.kind === "add")).toBe(true);
    const removed = computeUnifiedDiff("a\nb\n", "");
    expect(removed.hunks).toHaveLength(1);
    expect(removed.hunks[0]?.lines.every((l) => l.kind === "del")).toBe(true);
  });

  it("is deterministic across repeated runs", () => {
    const a = "x\ncommon\ny\ncommon\nz\n";
    const b = "x\nchanged\ny\nchanged\nz\n";
    const first = computeUnifiedDiff(a, b, "d.ts");
    const second = computeUnifiedDiff(a, b, "d.ts");
    expect(second).toEqual(first);
    expect(toUnifiedString(first)).toBe(toUnifiedString(second));
  });

  it("truncates when the LCS table would exceed the cell cap", () => {
    const cells = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 10;
    const a = Array.from({ length: cells }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: cells }, (_, i) => `b${i}`).join("\n");
    const { truncated } = diffLines(a, b);
    expect(truncated).toBe(true);
    const diff = computeUnifiedDiff(a, b);
    expect(diff.truncated).toBe(true);
    expect(diff.hunks.length).toBeGreaterThan(0);
  });

  it("renders unified strings with headers and prefixes", () => {
    const diff = computeUnifiedDiff("a\nb\n", "a\nB\n", "f.ts");
    const text = toUnifiedString(diff);
    expect(text).toContain("--- a/f.ts");
    expect(text).toContain("+++ b/f.ts");
    expect(text).toContain("@@ -1,3 +1,3 @@");
    expect(text).toContain(" a");
    expect(text).toContain("-b");
    expect(text).toContain("+B");
  });

  it("toUnifiedString honors an explicit path override", () => {
    const diff = computeUnifiedDiff("a\n", "b\n");
    expect(toUnifiedString(diff, "other.ts")).toContain("--- a/other.ts");
  });

  it("replacement pairs del before add deterministically", () => {
    const diff = computeUnifiedDiff("old\n", "new\n");
    expect(diff.hunks[0]?.lines.map((l) => l.kind)).toEqual(["del", "add", "context"]);
  });

  it("context window is exactly 3 lines around a change", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    const changed = lines.replace("l6", "CHANGED");
    const diff = computeUnifiedDiff(lines, changed);
    expect(diff.hunks).toHaveLength(1);
    const kinds = diff.hunks[0]?.lines.map((l) => l.kind) ?? [];
    expect(kinds.filter((k) => k === "context")).toHaveLength(6);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
  });

  it("preserves the optional path on the diff result", () => {
    expect(computeUnifiedDiff("a\n", "b\n", "p.ts").path).toBe("p.ts");
    expect(computeUnifiedDiff("a\n", "b\n").path).toBeUndefined();
  });
});
