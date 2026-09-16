// PR41: apps/desktop — Workspace IPC Dispatch Tests
//
// Channels validate in main before handlers run; missing workspace deps
// fail closed; there is no execute channel anywhere on the contract; and
// dispatch reaches the real services end to end.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { PermissionDecisionResult } from "@ai-desktop/ai-core";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import {
  DiagnosticsService,
  TerminalService,
  WorkspaceFileService,
  WorkspaceSearchService,
  type WorkspaceIpcDependencies,
} from "../main/workspace/index.js";
import { DefaultExecutionManager } from "@ai-desktop/execution";
import { LocalProcessSandboxProvider } from "@ai-desktop/execution";

const PROJECT = "proj-ipc";

let roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-ipc-"));
  roots.push(root);
  return root;
}

function makeDeps(root: string): WorkspaceIpcDependencies {
  const resolveRoot = (p: string): string | undefined => (p === PROJECT ? root : undefined);
  const permissionManager: PermissionManager = {
    check: async (): Promise<PermissionDecisionResult> => ({ kind: "allow" }),
    resolve: async () => true,
    revoke: async () => 0,
    getPendingRequest: () => undefined,
    listPendingRequests: () => [],
    listActivePolicies: async () => [],
  };
  return {
    fileService: new WorkspaceFileService({ resolveRoot }),
    searchService: new WorkspaceSearchService({ resolveRoot }),
    diagnosticsService: new DiagnosticsService(),
    terminalService: new TerminalService({
      executionManager: new DefaultExecutionManager({
        sandboxProvider: new LocalProcessSandboxProvider(),
      }),
      resolveRoot,
      permissionManager,
    }),
  };
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("apps/desktop: workspace IPC dispatch (PR41)", () => {
  it("declares the ten workspace channels with exact names", () => {
    expect(IPC_CHANNELS.WORKSPACE_FILES_LIST).toBe("workspace:files:list");
    expect(IPC_CHANNELS.WORKSPACE_FILES_READ).toBe("workspace:files:read");
    expect(IPC_CHANNELS.WORKSPACE_FILES_WRITE).toBe("workspace:files:write");
    expect(IPC_CHANNELS.WORKSPACE_FILES_CREATE).toBe("workspace:files:create");
    expect(IPC_CHANNELS.WORKSPACE_FILES_RENAME).toBe("workspace:files:rename");
    expect(IPC_CHANNELS.WORKSPACE_FILES_DELETE).toBe("workspace:files:delete");
    expect(IPC_CHANNELS.WORKSPACE_SEARCH).toBe("workspace:search");
    expect(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_REPORT).toBe("workspace:diagnostics:report");
    expect(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_LIST).toBe("workspace:diagnostics:list");
    expect(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_CLEAR).toBe("workspace:diagnostics:clear");
  });

  it("exposes no execute channel on the contract", () => {
    const values = Object.values(IPC_CHANNELS) as string[];
    for (const forbidden of [
      "workspace:execute",
      "filesystem:execute",
      "shell:execute",
      "node:execute",
    ]) {
      expect(values).not.toContain(forbidden);
    }
    expect(values.filter((c) => c.includes("execute"))).toEqual([]);
  });

  it("dispatches write -> read -> search -> list end to end", async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "hello.txt"), "hello indexer\n");
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(root) });

    const written = await registry.invokeCommand<{ result: { created: boolean } }>(
      IPC_CHANNELS.WORKSPACE_FILES_WRITE,
      { projectId: PROJECT, path: "new.txt", content: "written via ipc\n" },
    );
    expect(written.ok).toBe(true);

    const read = await registry.invokeCommand<{ result: { content: string } }>(
      IPC_CHANNELS.WORKSPACE_FILES_READ,
      { projectId: PROJECT, path: "new.txt" },
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.result.content).toBe("written via ipc\n");

    const searched = await registry.invokeCommand<{ result: { matches: unknown[] } }>(
      IPC_CHANNELS.WORKSPACE_SEARCH,
      { projectId: PROJECT, query: "written" },
    );
    expect(searched.ok).toBe(true);
    if (searched.ok) expect(searched.value.result.matches).toHaveLength(1);

    const listed = await registry.invokeCommand<{ diagnostics: unknown[] }>(
      IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_LIST,
      { projectId: PROJECT },
    );
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.diagnostics).toEqual([]);
  });

  it("validates input before handlers run (missing projectId, empty query)", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    const missingProject = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_READ, {
      path: "x.ts",
    });
    expect(missingProject.ok).toBe(false);
    const emptyQuery = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_SEARCH, {
      projectId: PROJECT,
      query: "",
    });
    expect(emptyQuery.ok).toBe(false);
    const oversized = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_WRITE, {
      projectId: PROJECT,
      path: "x.txt",
      content: "x".repeat(262_144 + 1),
    });
    expect(oversized.ok).toBe(false);
  });

  it("fails closed without workspace deps", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {} });
    const res = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_LIST, {
      projectId: PROJECT,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("not available");
  });

  it("dispatches create/rename/delete through the registry", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });

    const created = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_CREATE, {
      projectId: PROJECT,
      path: "a.txt",
      content: "a",
    });
    expect(created.ok).toBe(true);

    const renamed = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_RENAME, {
      projectId: PROJECT,
      from: "a.txt",
      to: "b.txt",
    });
    expect(renamed.ok).toBe(true);

    const deleted = await registry.invokeCommand<{ result: { deleted: boolean } }>(
      IPC_CHANNELS.WORKSPACE_FILES_DELETE,
      { projectId: PROJECT, path: "b.txt" },
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.value.result.deleted).toBe(true);
  });

  it("dispatches diagnostics report -> list -> clear through the registry", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });

    const reported = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_REPORT, {
      projectId: PROJECT,
      source: "tsc",
      diagnostics: [{ path: "src/a.ts", line: 1, column: 1, severity: "error", message: "boom" }],
    });
    expect(reported.ok).toBe(true);

    const listed = await registry.invokeCommand<{ diagnostics: unknown[] }>(
      IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_LIST,
      { projectId: PROJECT },
    );
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.diagnostics).toHaveLength(1);

    const cleared = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_CLEAR, {
      projectId: PROJECT,
    });
    expect(cleared.ok).toBe(true);
  });

  it("rejects malformed diagnostics and traversal paths at the boundary", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    const badSeverity = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_REPORT, {
      projectId: PROJECT,
      source: "tsc",
      diagnostics: [{ path: "a.ts", line: 1, column: 1, severity: "fatal", message: "x" }],
    });
    expect(badSeverity.ok).toBe(false);
    const traversal = await registry.invokeCommand<{ result: unknown }>(
      IPC_CHANNELS.WORKSPACE_FILES_READ,
      { projectId: PROJECT, path: "../escape.txt" },
    );
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.message).toContain("OUTSIDE_WORKSPACE");
  });

  it("surfaces unregistered projects as typed NO_WORKSPACE failures", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_LIST, {
      projectId: "ghost",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("NO_WORKSPACE");
  });

  it("binary reads surface a typed BINARY_FILE failure", async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(root) });
    const res = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_READ, {
      projectId: PROJECT,
      path: "blob.bin",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("BINARY_FILE");
  });

  it("registers all ten workspace channels on the registry", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    for (const channel of [
      IPC_CHANNELS.WORKSPACE_FILES_LIST,
      IPC_CHANNELS.WORKSPACE_FILES_READ,
      IPC_CHANNELS.WORKSPACE_FILES_WRITE,
      IPC_CHANNELS.WORKSPACE_FILES_CREATE,
      IPC_CHANNELS.WORKSPACE_FILES_RENAME,
      IPC_CHANNELS.WORKSPACE_FILES_DELETE,
      IPC_CHANNELS.WORKSPACE_SEARCH,
      IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_REPORT,
      IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_LIST,
      IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_CLEAR,
    ]) {
      expect(registry.registeredChannels.has(channel)).toBe(true);
    }
  });

  it("exposes no execute handler on the registry", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    for (const channel of registry.registeredChannels) {
      expect(channel).not.toContain("execute");
    }
  });
});

describe("apps/desktop: terminal IPC dispatch (PR41)", () => {
  it("declares the six terminal channels with exact names", () => {
    expect(IPC_CHANNELS.TERMINAL_LIST).toBe("terminal:list");
    expect(IPC_CHANNELS.TERMINAL_CREATE).toBe("terminal:create");
    expect(IPC_CHANNELS.TERMINAL_WRITE).toBe("terminal:write");
    expect(IPC_CHANNELS.TERMINAL_RESIZE).toBe("terminal:resize");
    expect(IPC_CHANNELS.TERMINAL_STOP).toBe("terminal:stop");
    expect(IPC_CHANNELS.TERMINAL_OUTPUT).toBe("terminal:output");
  });

  it("creates, outputs, and stops a terminal end to end", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });

    const created = await registry.invokeCommand<{ result: { id: string } }>(
      IPC_CHANNELS.TERMINAL_CREATE,
      {
        projectId: PROJECT,
        command: process.execPath,
        args: ["-e", "process.stdout.write('term-hi')"],
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.value.result.id;

    const output = await registry.invokeCommand<{ result: { text: string } }>(
      IPC_CHANNELS.TERMINAL_OUTPUT,
      { projectId: PROJECT, sessionId },
    );
    expect(output.ok).toBe(true);
    if (output.ok) expect(output.value.result.text).toContain("term-hi");

    const listed = await registry.invokeCommand<{ result: unknown[] }>(IPC_CHANNELS.TERMINAL_LIST, {
      projectId: PROJECT,
    });
    expect(listed.ok).toBe(true);

    const stopped = await registry.invokeCommand(IPC_CHANNELS.TERMINAL_STOP, {
      projectId: PROJECT,
      sessionId,
    });
    expect(stopped.ok).toBe(true);
  });

  it("write fails closed (no stdin channel)", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.TERMINAL_WRITE, {
      projectId: PROJECT,
      sessionId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 26),
      input: "echo hi\n",
    });
    expect(res.ok).toBe(false);
  });

  it("validates terminal input before handlers run", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeDeps(makeRoot()) });
    const noProject = await registry.invokeCommand(IPC_CHANNELS.TERMINAL_LIST, {});
    expect(noProject.ok).toBe(false);
    const badSize = await registry.invokeCommand(IPC_CHANNELS.TERMINAL_RESIZE, {
      projectId: PROJECT,
      sessionId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 26),
      cols: 5,
      rows: 2,
    });
    expect(badSize.ok).toBe(false);
  });
});
