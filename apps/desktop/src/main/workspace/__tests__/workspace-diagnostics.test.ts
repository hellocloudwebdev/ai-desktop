// PR41: apps/desktop — DiagnosticsService Tests
//
// Report/list/clear, severity ranking, malformed entries, caps, isolation.

import { describe, expect, it } from "vitest";
import { DiagnosticsService, DIAGNOSTICS_MAX_PER_SOURCE } from "../workspace-diagnostics.js";
import { WorkspaceError } from "../workspace-errors.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/a.ts",
    line: 1,
    column: 1,
    severity: "error" as const,
    message: "boom",
    ...overrides,
  };
}

describe("apps/desktop: DiagnosticsService (PR41)", () => {
  it("reports and lists diagnostics merged across sources", () => {
    const svc = new DiagnosticsService();
    const outcome = svc.report({ projectId: "p", source: "tsc", diagnostics: [entry()] });
    expect(outcome).toEqual({ stored: 1, evicted: 0, totalForSource: 1 });
    svc.report({
      projectId: "p",
      source: "eslint",
      diagnostics: [entry({ path: "src/b.ts", severity: "warning", message: "lint" })],
    });
    const listed = svc.list({ projectId: "p" });
    expect(listed).toHaveLength(2);
    expect(listed.map((d) => d.source).sort()).toEqual(["eslint", "tsc"]);
  });

  it("sorts by severity rank, then path, then line", () => {
    const svc = new DiagnosticsService();
    svc.report({
      projectId: "p",
      source: "s",
      diagnostics: [
        entry({ path: "b.ts", severity: "hint", message: "h" }),
        entry({ path: "a.ts", line: 5, severity: "warning", message: "w" }),
        entry({ path: "a.ts", line: 2, severity: "warning", message: "w2" }),
        entry({ path: "c.ts", severity: "error", message: "e" }),
        entry({ path: "d.ts", severity: "information", message: "i" }),
      ],
    });
    const listed = svc.list({ projectId: "p" });
    expect(listed.map((d) => d.message)).toEqual(["e", "w2", "w", "i", "h"]);
  });

  it("scopes list() by path prefix", () => {
    const svc = new DiagnosticsService();
    svc.report({
      projectId: "p",
      source: "s",
      diagnostics: [entry({ path: "src/a.ts" }), entry({ path: "other/b.ts" })],
    });
    expect(svc.list({ projectId: "p", path: "src" })).toHaveLength(1);
    expect(svc.list({ projectId: "p", path: "src/a.ts" })).toHaveLength(1);
    expect(svc.list({ projectId: "p", path: "missing" })).toHaveLength(0);
  });

  it("clears a single source or the whole project", () => {
    const svc = new DiagnosticsService();
    svc.report({ projectId: "p", source: "a", diagnostics: [entry(), entry()] });
    svc.report({ projectId: "p", source: "b", diagnostics: [entry()] });
    expect(svc.clear({ projectId: "p", source: "a" })).toEqual({ cleared: 2 });
    expect(svc.list({ projectId: "p" })).toHaveLength(1);
    expect(svc.clear({ projectId: "p" })).toEqual({ cleared: 1 });
    expect(svc.list({ projectId: "p" })).toEqual([]);
    expect(svc.clear({ projectId: "p" })).toEqual({ cleared: 0 });
  });

  it("rejects malformed entries with typed errors and stores nothing", () => {
    const svc = new DiagnosticsService();
    const bad = [
      entry({ path: "" }),
      entry({ line: 0 }),
      entry({ column: -1 }),
      entry({ severity: "fatal" }),
      entry({ message: "" }),
      entry({ code: 42 }),
    ];
    for (const candidate of bad) {
      expect(() =>
        svc.report({ projectId: "p", source: "s", diagnostics: [candidate] }),
      ).toThrowError(WorkspaceError);
    }
    expect(svc.list({ projectId: "p" })).toEqual([]);
    expect(() => svc.report({ projectId: "", source: "s", diagnostics: [] })).toThrowError(
      WorkspaceError,
    );
    expect(() => svc.report({ projectId: "p", source: "", diagnostics: [] })).toThrowError(
      WorkspaceError,
    );
  });

  it("caps at 500 per source with oldest-first eviction", () => {
    const svc = new DiagnosticsService();
    const diagnostics = Array.from({ length: DIAGNOSTICS_MAX_PER_SOURCE + 50 }, (_, i) =>
      entry({ line: i + 1, message: `m${i}` }),
    );
    const outcome = svc.report({ projectId: "p", source: "s", diagnostics });
    expect(outcome.stored).toBe(DIAGNOSTICS_MAX_PER_SOURCE + 50);
    expect(outcome.evicted).toBe(50);
    expect(outcome.totalForSource).toBe(DIAGNOSTICS_MAX_PER_SOURCE);
    const listed = svc.list({ projectId: "p" });
    expect(listed).toHaveLength(DIAGNOSTICS_MAX_PER_SOURCE);
    expect(listed[0]?.message).toBe("m50");
  });

  it("re-reporting a source replaces its previous diagnostics", () => {
    const svc = new DiagnosticsService();
    svc.report({ projectId: "p", source: "s", diagnostics: [entry({ message: "old" })] });
    svc.report({ projectId: "p", source: "s", diagnostics: [entry({ message: "new" })] });
    const listed = svc.list({ projectId: "p" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.message).toBe("new");
  });

  it("isolates diagnostics per project", () => {
    const svc = new DiagnosticsService();
    svc.report({ projectId: "pa", source: "s", diagnostics: [entry()] });
    expect(svc.list({ projectId: "pb" })).toEqual([]);
    expect(svc.count("pa")).toBe(1);
    expect(svc.count("pb")).toBe(0);
    svc.clear({ projectId: "pa" });
    expect(svc.count("pa")).toBe(0);
  });

  it("accepts optional codes and all four severities", () => {
    const svc = new DiagnosticsService();
    svc.report({
      projectId: "p",
      source: "s",
      diagnostics: [
        entry({ severity: "error", code: "TS2345", message: "e" }),
        entry({ severity: "warning", message: "w" }),
        entry({ severity: "information", message: "i" }),
        entry({ severity: "hint", message: "h" }),
      ],
    });
    const listed = svc.list({ projectId: "p" });
    expect(listed).toHaveLength(4);
    expect(listed[0]).toMatchObject({ severity: "error", code: "TS2345" });
  });

  it("reports empty arrays without error", () => {
    const svc = new DiagnosticsService();
    expect(svc.report({ projectId: "p", source: "s", diagnostics: [] })).toEqual({
      stored: 0,
      evicted: 0,
      totalForSource: 0,
    });
  });

  it("clear of an unknown source is a no-op", () => {
    const svc = new DiagnosticsService();
    expect(svc.clear({ projectId: "p", source: "nope" })).toEqual({ cleared: 0 });
    expect(svc.clear({ projectId: "p" })).toEqual({ cleared: 0 });
  });

  it("list of an unknown project returns an empty array", () => {
    expect(new DiagnosticsService().list({ projectId: "ghost" })).toEqual([]);
  });
});
