// PR41: apps/desktop — Coding Workspace E2E Tests
//
// End-to-end flows over the REAL services (no mocks): WorkspaceFileService,
// WorkspaceSearchService, DiagnosticsService, TerminalService with a REAL
// DefaultExecutionManager + LocalProcessSandboxProvider, and the pure diff
// module. One tmp project root per test.
//
// E2E1 walks the full loop: create -> open (read) -> edit -> save ->
// agent-tool read -> agent write -> status/mtime conflict detection ->
// run command -> output appears.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionManager, PermissionPolicy } from "@ai-desktop/permissions";
import type {
  PermissionCheck,
  PermissionDecisionResult,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";
import { WorkspaceFileService } from "../main/workspace/workspace-files.js";
import { WorkspaceSearchService } from "../main/workspace/workspace-search.js";
import { DiagnosticsService } from "../main/workspace/workspace-diagnostics.js";
import { TerminalService } from "../main/workspace/terminal-service.js";
import { WorkspaceError } from "../main/workspace/workspace-errors.js";
import {
  computeUnifiedDiff,
  diffLines,
  toUnifiedString,
} from "../main/workspace/workspace-diff.js";

const PROJECT = "proj-e2e";
const OTHER = "proj-e2e-other";

let roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
  roots.push(root);
  return root;
}

class AllowAllPermissions implements PermissionManager {
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    void request; return { kind: "allow" };
  }
  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): PermissionRequest | undefined {
    return undefined;
  }
  listPendingRequests(): readonly PermissionRequest[] {
    return [];
  }
  async listActivePolicies(): Promise<readonly PermissionPolicy[]> {
    return [];
  }
}

interface E2EWorld {
  root: string;
  files: WorkspaceFileService;
  search: WorkspaceSearchService;
  diagnostics: DiagnosticsService;
  terminals: TerminalService;
}

function makeWorld(root: string): E2EWorld {
  const resolveRoot = (p: string): string | undefined => {
    if (p === PROJECT) return root;
    return undefined;
  };
  return {
    root,
    files: new WorkspaceFileService({ resolveRoot }),
    search: new WorkspaceSearchService({ resolveRoot }),
    diagnostics: new DiagnosticsService(),
    terminals: new TerminalService({
      executionManager: new DefaultExecutionManager({
        sandboxProvider: new LocalProcessSandboxProvider(),
      }),
      resolveRoot,
      permissionManager: new AllowAllPermissions(),
    }),
  };
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("apps/desktop: coding workspace E2E (PR41)", () => {
  it("E2E1: create -> open -> edit -> save -> agent read/write -> conflict detect -> run command", async () => {
    const world = makeWorld(makeRoot());

    // Create + open (read).
    world.files.createFile({ projectId: PROJECT, path: "src/app.ts", content: "const v = 1;\n" });
    const opened = world.files.readFile({ projectId: PROJECT, path: "src/app.ts" });
    expect(opened.content).toBe("const v = 1;\n");

    // Edit + save.
    const edited = "const v = 2;\n";
    const saved = world.files.writeFile({
      projectId: PROJECT,
      path: "src/app.ts",
      content: edited,
    });
    expect(saved.created).toBe(false);

    // Agent-tool read (simulated via the same file service an agent write
    // path uses) sees the updated content.
    const agentRead = world.files.readFile({ projectId: PROJECT, path: "src/app.ts" });
    expect(agentRead.content).toBe(edited);

    // Agent write lands; status mtime changes.
    const before = world.files.getStatus({ projectId: PROJECT, path: "src/app.ts" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    world.files.writeFile({
      projectId: PROJECT,
      path: "src/app.ts",
      content: "const v = 3; // agent\n",
    });
    const after = world.files.getStatus({ projectId: PROJECT, path: "src/app.ts" });
    expect(after.mtimeMs).not.toBe(before.mtimeMs);

    // Editor conflict detection (inline, as the renderer does): the open tab
    // still holds the pre-agent mtime, so the fresh read flags a conflict.
    const tabMtimeMs = agentRead.mtimeMs;
    const diskNow = world.files.readFile({ projectId: PROJECT, path: "src/app.ts" });
    const conflict = diskNow.mtimeMs !== tabMtimeMs;
    expect(conflict).toBe(true);

    // Saving with the stale mtime is rejected; disk keeps the agent version.
    try {
      world.files.writeFile({
        projectId: PROJECT,
        path: "src/app.ts",
        content: "stale overwrite\n",
        expectedMtimeMs: tabMtimeMs,
      });
      throw new Error("expected EXTERNAL_MODIFIED");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).workspaceCode).toBe("EXTERNAL_MODIFIED");
    }
    expect(world.files.readFile({ projectId: PROJECT, path: "src/app.ts" }).content).toBe(
      "const v = 3; // agent\n",
    );

    // Run a command in the workspace terminal; output appears via output().
    const created = await world.terminals.create({ projectId: PROJECT });
    const started = await world.terminals.start({
      sessionId: created.id,
      projectId: PROJECT,
      command: process.execPath,
      args: ["-e", 'process.stdout.write("e2e-output-ok")'],
    });
    expect(started.state).toBe("stopped");
    const out = world.terminals.output({ sessionId: created.id, projectId: PROJECT });
    expect(out.text).toContain("e2e-output-ok");
  });

  it("E2E2: project isolation — B sees neither A's terminals nor A's files", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const resolveRoot = (p: string): string | undefined => {
      if (p === PROJECT) return rootA;
      if (p === OTHER) return rootB;
      return undefined;
    };
    const pm = new AllowAllPermissions();
    const terminals = new TerminalService({
      executionManager: new DefaultExecutionManager({
        sandboxProvider: new LocalProcessSandboxProvider(),
      }),
      resolveRoot,
      permissionManager: pm,
    });
    const files = new WorkspaceFileService({ resolveRoot });

    files.createFile({ projectId: PROJECT, path: "a-only.txt", content: "a\n" });
    await terminals.create({ projectId: PROJECT });

    // Terminal list is project-scoped: B sees nothing.
    expect(terminals.list({ projectId: OTHER })).toHaveLength(0);
    expect(terminals.list({ projectId: PROJECT })).toHaveLength(1);

    // A's file is unreadable via B's project binding.
    try {
      files.readFile({ projectId: OTHER, path: "a-only.txt" });
      throw new Error("expected NOT_FOUND");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).workspaceCode).toBe("NOT_FOUND");
    }

    // Unknown project fails closed.
    try {
      files.readFile({ projectId: "ghost", path: "a-only.txt" });
      throw new Error("expected NO_WORKSPACE");
    } catch (err: unknown) {
      expect((err as WorkspaceError).workspaceCode).toBe("NO_WORKSPACE");
    }
  });

  it("E2E3: external modification conflict — stale save rejected, disk keeps v2", async () => {
    const world = makeWorld(makeRoot());
    world.files.createFile({ projectId: PROJECT, path: "doc.txt", content: "v1\n" });
    const tab = world.files.readFile({ projectId: PROJECT, path: "doc.txt" });
    const mtime1 = tab.mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    world.files.writeFile({ projectId: PROJECT, path: "doc.txt", content: "v2 external\n" });
    const onDisk = world.files.readFile({ projectId: PROJECT, path: "doc.txt" });
    expect(onDisk.mtimeMs).not.toBe(mtime1);

    try {
      world.files.writeFile({
        projectId: PROJECT,
        path: "doc.txt",
        content: "stale save\n",
        expectedMtimeMs: mtime1,
      });
      throw new Error("expected EXTERNAL_MODIFIED");
    } catch (err: unknown) {
      expect((err as WorkspaceError).workspaceCode).toBe("EXTERNAL_MODIFIED");
    }
    expect(world.files.readFile({ projectId: PROJECT, path: "doc.txt" }).content).toBe(
      "v2 external\n",
    );
  });

  it("E2E4: diff — v1 vs v2 yields add/del hunks and the path in unified form", () => {
    const world = makeWorld(makeRoot());
    const v1 = "line one\nline two\nline three\n";
    const v2 = "line one\nline TWO edited\nline three\nline four\n";
    world.files.createFile({ projectId: PROJECT, path: "diff-me.txt", content: v1 });

    const { lines } = diffLines(v1, v2);
    const kinds = new Set(lines.map((l) => l.kind));
    expect(kinds.has("add")).toBe(true);
    expect(kinds.has("del")).toBe(true);

    const diff = computeUnifiedDiff(v1, v2, "diff-me.txt");
    expect(diff.hunks.length).toBeGreaterThan(0);
    const text = toUnifiedString(diff);
    expect(text).toContain("diff-me.txt");
    expect(text).toContain("-line two");
    expect(text).toContain("+line TWO edited");
  });

  it("E2E5: search -> open — marker found with line/col, read at line returns it", () => {
    const world = makeWorld(makeRoot());
    world.files.createFile({
      projectId: PROJECT,
      path: "src/marked.ts",
      content: "first line\nsecond line with NEEDLE_MARKER here\nthird\n",
    });
    const outcome = world.search.search({ projectId: PROJECT, query: "NEEDLE_MARKER" });
    expect(outcome.matches.length).toBeGreaterThan(0);
    const match = outcome.matches[0];
    expect(match).toBeDefined();
    if (!match) throw new Error("expected a search match");
    expect(match.path).toBe("src/marked.ts");
    expect(match.line).toBe(2);
    expect(match.column).toBeGreaterThan(0);

    const opened = world.files.readFile({
      projectId: PROJECT,
      path: match.path,
      startLine: match.line,
      endLine: match.line,
    });
    expect(opened.content).toContain("NEEDLE_MARKER");
  });

  it("E2E6: diagnostics — error ranks above warning, clear removes all", () => {
    const world = makeWorld(makeRoot());
    world.files.createFile({ projectId: PROJECT, path: "src/a.ts", content: "const a = 1;\n" });
    world.diagnostics.report({
      projectId: PROJECT,
      source: "tsc",
      diagnostics: [
        { path: "src/a.ts", line: 2, column: 5, severity: "warning", message: "unused var" },
        { path: "src/a.ts", line: 1, column: 1, severity: "error", message: "type boom" },
      ],
    });
    const listed = world.diagnostics.list({ projectId: PROJECT });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.severity).toBe("error");
    expect(listed[1]?.severity).toBe("warning");
    const cleared = world.diagnostics.clear({ projectId: PROJECT });
    expect(cleared.cleared).toBe(2);
    expect(world.diagnostics.list({ projectId: PROJECT })).toHaveLength(0);
  });
});
