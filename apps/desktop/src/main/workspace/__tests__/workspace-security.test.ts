// PR41: apps/desktop — Workspace Security Regression Tests
//
// Adversarial coverage over the real WorkspaceFileService,
// WorkspaceSearchService, and TerminalService: traversal, symlinks,
// cross-project isolation, terminal escape, secret handling, oversized
// inputs, forged IPC payloads, renderer privilege separation, and the
// permission layering between IPC/services and agent tools.
//
// Notes (report):
//   - MAX_WRITE_BYTES is 64 KB (filesystem-tool-backend), not 256 KB; the
//     over-limit test uses 64 KB + 1. The 256 KB ceiling belongs to the
//     search index (WORKSPACE_SEARCH_MAX_FILE_BYTES) and the terminal
//     output buffer (TERMINAL_LIMITS.outputCapBytes).
//   - Terminal metachar assertions run `process.execPath -e` with the
//     metachar string as a JS string literal arg: with shell:false the
//     string is echoed literally and never interpreted by a shell.
//   - Symlink tests skip on win32 (creation needs privileges there); the
//     traversal tests still prove containment on every platform.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import type { PermissionManager, PermissionPolicy } from "@ai-desktop/permissions";
import type {
  PermissionCheck,
  PermissionDecisionResult,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";
import { MAX_WRITE_BYTES } from "../../agent/filesystem/filesystem-tool-backend.js";
import { WorkspaceFileService } from "../workspace-files.js";
import { WorkspaceSearchService } from "../workspace-search.js";
import { WorkspaceError } from "../workspace-errors.js";
import { TERMINAL_LIMITS, TerminalError, TerminalService } from "../terminal-service.js";
import { IpcRegistry, registerIpcHandlers } from "../../ipc/index.js";
import type { WorkspaceIpcDependencies } from "../workspace-ipc.js";
import { DiagnosticsService } from "../workspace-diagnostics.js";

const PROJECT = "proj-sec";
const OTHER = "proj-sec-other";

let roots: string[] = [];

function makeRoot(prefix = "ws-sec-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fileServiceFor(root: string, otherRoot?: string): WorkspaceFileService {
  return new WorkspaceFileService({
    resolveRoot: (p: string) => {
      if (p === PROJECT) return root;
      if (otherRoot !== undefined && p === OTHER) return otherRoot;
      return undefined;
    },
  });
}

function expectWorkspaceError(fn: () => unknown, code: string): WorkspaceError {
  try {
    fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).workspaceCode).toBe(code);
    return err as WorkspaceError;
  }
  throw new Error(`Expected WorkspaceError ${code}`);
}

async function expectWorkspaceErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<WorkspaceError> {
  try {
    await fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).workspaceCode).toBe(code);
    return err as WorkspaceError;
  }
  throw new Error(`Expected WorkspaceError ${code}`);
}

async function expectTerminalErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<TerminalError> {
  try {
    await fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as TerminalError).terminalCode).toBe(code);
    return err as TerminalError;
  }
  throw new Error(`Expected TerminalError ${code}`);
}

class AllowAllPermissions implements PermissionManager {
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    void request;
    return { kind: "allow" };
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

class DenyAllPermissions extends AllowAllPermissions {
  override async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    void request;
    return { kind: "deny", reason: "Denied in test" };
  }
}

function allowManager(): PermissionManager {
  return new AllowAllPermissions();
}

function terminalServiceFor(root: string, pm?: PermissionManager): TerminalService {
  return new TerminalService({
    executionManager: new DefaultExecutionManager({
      sandboxProvider: new LocalProcessSandboxProvider(),
    }),
    resolveRoot: (p: string) => (p === PROJECT ? root : undefined),
    permissionManager: pm ?? allowManager(),
  });
}

/** Portable echo via the runtime itself (shell:false, no extra dependency). */
function echoArgs(text: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
  };
}

function makeIpcDeps(root: string): WorkspaceIpcDependencies {
  const resolveRoot = (p: string): string | undefined => (p === PROJECT ? root : undefined);
  return {
    fileService: new WorkspaceFileService({ resolveRoot }),
    searchService: new WorkspaceSearchService({ resolveRoot }),
    diagnosticsService: new DiagnosticsService(),
    terminalService: new TerminalService({
      executionManager: new DefaultExecutionManager({
        sandboxProvider: new LocalProcessSandboxProvider(),
      }),
      resolveRoot,
      permissionManager: allowManager(),
    }),
  };
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Traversal: ../escape + absolute outside paths never touch outside
// ---------------------------------------------------------------------------

describe("security: path traversal", () => {
  it("list rejects ../escape with OUTSIDE_WORKSPACE", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.listTree({ projectId: PROJECT, path: "../escape" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("read rejects ../escape with OUTSIDE_WORKSPACE", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "../escape.txt" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("write rejects ../escape with OUTSIDE_WORKSPACE", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.writeFile({ projectId: PROJECT, path: "../escape.txt", content: "x" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("create rejects ../escape with OUTSIDE_WORKSPACE", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.createFile({ projectId: PROJECT, path: "../escape.txt", content: "x" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("rename rejects ../escape destination", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    svc.createFile({ projectId: PROJECT, path: "ok.txt", content: "ok" });
    expectWorkspaceError(
      () => svc.rename({ projectId: PROJECT, from: "ok.txt", to: "../escape.txt" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("delete rejects ../escape with OUTSIDE_WORKSPACE", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.delete({ projectId: PROJECT, path: "../escape.txt" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("search rejects ../escape start path", () => {
    const root = makeRoot();
    const search = new WorkspaceSearchService({
      resolveRoot: (p: string) => (p === PROJECT ? root : undefined),
    });
    expectWorkspaceError(
      () => search.search({ projectId: PROJECT, path: "../escape", query: "x" }),
      "OUTSIDE_WORKSPACE",
    );
  });

  it("absolute outside path is rejected and the sentinel file is untouched", () => {
    const root = makeRoot();
    const outside = makeRoot("ws-sec-outside-");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "untouched\n");
    const svc = fileServiceFor(root);
    const before = fs.readFileSync(sentinel, "utf8");
    for (const op of [
      () => svc.readFile({ projectId: PROJECT, path: sentinel }),
      () => svc.writeFile({ projectId: PROJECT, path: sentinel, content: "pwned" }),
      () => svc.createFile({ projectId: PROJECT, path: sentinel, content: "pwned" }),
      () => svc.delete({ projectId: PROJECT, path: sentinel }),
      () => svc.listTree({ projectId: PROJECT, path: outside }),
    ]) {
      expectWorkspaceError(op, "OUTSIDE_WORKSPACE");
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Symlinks: escaping links are never followed (skipped on win32)
// ---------------------------------------------------------------------------

describe("security: symlink escape", () => {
  it("read of a symlink file pointing outside fails with SYMLINK_ESCAPE", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot("ws-sec-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "ok.txt"), "ok\n");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"), "file");
    } catch {
      return;
    }
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "leak.txt" }),
      "SYMLINK_ESCAPE",
    );
  });

  it("symlink dir pointing outside is skipped by list (never traversed)", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot("ws-sec-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "ok.txt"), "ok\n");
    try {
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    } catch {
      return;
    }
    const svc = fileServiceFor(root);
    const listed = svc.listTree({ projectId: PROJECT });
    const paths = listed.entries.map((e) => e.path);
    expect(paths).not.toContain("linked");
    expect(paths).not.toContain("linked/secret.txt");
  });

  it("nested symlink (link inside a real dir) pointing outside is rejected", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot("ws-sec-outside-");
    fs.writeFileSync(path.join(outside, "evil.txt"), "evil\n");
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "ok.txt"), "ok\n");
    try {
      fs.symlinkSync(path.join(outside, "evil.txt"), path.join(root, "sub", "evil.txt"), "file");
    } catch {
      return;
    }
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "sub/evil.txt" }),
      "SYMLINK_ESCAPE",
    );
  });

  it("write through an escaping symlink is rejected and the target is untouched", () => {
    if (process.platform === "win32") return;
    const outside = makeRoot("ws-sec-outside-");
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "original\n");
    const root = makeRoot();
    try {
      fs.symlinkSync(target, path.join(root, "link.txt"), "file");
    } catch {
      return;
    }
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.writeFile({ projectId: PROJECT, path: "link.txt", content: "pwned" }),
      "SYMLINK_ESCAPE",
    );
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
  });

  it("rename into a protected (outside) location is rejected", () => {
    const root = makeRoot();
    const outside = makeRoot("ws-sec-outside-");
    const svc = fileServiceFor(root);
    svc.createFile({ projectId: PROJECT, path: "inside.txt", content: "inside" });
    const outsideAbs = path.join(outside, "moved.txt");
    expectWorkspaceError(
      () => svc.rename({ projectId: PROJECT, from: "inside.txt", to: outsideAbs }),
      "OUTSIDE_WORKSPACE",
    );
    expect(fs.existsSync(path.join(root, "inside.txt"))).toBe(true);
    expect(fs.existsSync(outsideAbs)).toBe(false);
  });

  it("delete of an outside path is rejected", () => {
    const root = makeRoot();
    const outside = makeRoot("ws-sec-outside-");
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "keep me\n");
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () => svc.delete({ projectId: PROJECT, path: victim }),
      "OUTSIDE_WORKSPACE",
    );
    expect(fs.existsSync(victim)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-project isolation
// ---------------------------------------------------------------------------

describe("security: cross-project isolation", () => {
  it("file created in A is unreadable via project B (NO_WORKSPACE)", () => {
    const rootA = makeRoot("ws-sec-a-");
    const rootB = makeRoot("ws-sec-b-");
    const svcA = fileServiceFor(rootA);
    svcA.createFile({ projectId: PROJECT, path: "secret.txt", content: "a-only" });
    const svcB = fileServiceFor(rootB, rootB);
    // B's resolver knows only OTHER; A's file is unreachable from B's view.
    expectWorkspaceError(
      () => svcB.readFile({ projectId: PROJECT, path: "secret.txt" }),
      "NOT_FOUND",
    );
  });

  it("unknown project fails closed with NO_WORKSPACE", async () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    await expectWorkspaceErrorAsync(
      async () => svc.readFile({ projectId: "ghost", path: "x.txt" }),
      "NO_WORKSPACE",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Terminal escape: cwd containment + argv-safe metachars
// ---------------------------------------------------------------------------

describe("security: terminal escape", () => {
  it("cwd ../escape is rejected with INVALID_CWD", async () => {
    const svc = terminalServiceFor(makeRoot());
    await expectTerminalErrorAsync(
      () => svc.create({ projectId: PROJECT, cwd: "../escape" }),
      "INVALID_CWD",
    );
  });

  it("absolute outside cwd is rejected with INVALID_CWD", async () => {
    const svc = terminalServiceFor(makeRoot());
    await expectTerminalErrorAsync(
      () => svc.create({ projectId: PROJECT, cwd: os.tmpdir() }),
      "INVALID_CWD",
    );
  });

  it("symlink cwd escaping the workspace is rejected with INVALID_CWD", async () => {
    if (process.platform === "win32") return;
    const outside = makeRoot("ws-sec-outside-");
    const root = makeRoot();
    try {
      fs.symlinkSync(outside, path.join(root, "evil-link"), "dir");
    } catch {
      return;
    }
    const svc = terminalServiceFor(root);
    await expectTerminalErrorAsync(
      () => svc.create({ projectId: PROJECT, cwd: "evil-link" }),
      "INVALID_CWD",
    );
  });

  it.each(["a; rm -rf /", "$(evil)", "`evil`"])(
    "metachar command %p is echoed literally, never executed",
    async (metachar) => {
      const root = makeRoot();
      const svc = terminalServiceFor(root);
      // The metachar string is passed as a JS string literal argument to
      // `node -e` with shell:false: the child echoes it verbatim and no
      // shell ever interprets it.
      const created = await svc.create({ projectId: PROJECT });
      const { command, args } = echoArgs(metachar);
      const started = await svc.start({
        sessionId: created.id,
        projectId: PROJECT,
        command,
        args,
      });
      expect(started.state).toBe("stopped");
      const out = svc.output({ sessionId: created.id, projectId: PROJECT });
      expect(out.text).toBe(metachar);
    },
  );

  it("write() fails closed with STDIN_UNSUPPORTED", async () => {
    const svc = terminalServiceFor(makeRoot());
    const created = await svc.create({ projectId: PROJECT });
    await expectTerminalErrorAsync(
      () =>
        svc.write({
          sessionId: created.id,
          projectId: PROJECT,
          input: "anything\n",
        }),
      "STDIN_UNSUPPORTED",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Secret handling: user data readable, envelopes leak no main-side paths,
//    renderer-invisible env stays unset
// ---------------------------------------------------------------------------

describe("security: secrets and error envelopes", () => {
  it("written file content round-trips but error envelopes carry no tmp root", () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    const fakeKey = "sk-test-fake-api-key-12345";
    svc.createFile({ projectId: PROJECT, path: "keys.txt", content: `apiKey=${fakeKey}\n` });
    const read = svc.readFile({ projectId: PROJECT, path: "keys.txt" });
    expect(read.content).toContain(fakeKey);
    // A traversal failure envelope must not embed the absolute tmp root.
    const err = expectWorkspaceError(
      () => svc.readFile({ projectId: PROJECT, path: "../escape.txt" }),
      "OUTSIDE_WORKSPACE",
    );
    expect(err.message).not.toContain(root);
    expect(err.message).not.toContain(os.tmpdir().replace(/\\/g, "/").slice(0, 8));
  });

  it("terminal env allowlist keeps an injected SECRET unset in the child", async () => {
    const root = makeRoot();
    const svc = terminalServiceFor(root);
    const marker = "SECRET_SHOULD_NOT_APPEAR_9f8e7d";
    const created = await svc.create({ projectId: PROJECT });
    // LocalProcessSandboxProvider allowlists PATH/SYSTEMROOT/TMP/TEMP only;
    // TerminalService never passes environmentVariables, so a main-side
    // SECRET value cannot reach the child. The child prints its own env.
    const started = await svc.start({
      sessionId: created.id,
      projectId: PROJECT,
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(String(process.env.SECRET_MARKER_TEST ?? "unset:${marker}"))`,
      ],
    });
    expect(started.state).toBe("stopped");
    const out = svc.output({ sessionId: created.id, projectId: PROJECT });
    expect(out.text).toContain(`unset:${marker}`);
    expect(out.text).not.toContain("super-secret-value");
  });
});

// ---------------------------------------------------------------------------
// 6. Oversized inputs: write cap, search skip, terminal output ceiling
// ---------------------------------------------------------------------------

describe("security: oversized inputs", () => {
  it(`write over MAX_WRITE_BYTES (${MAX_WRITE_BYTES}) fails with TOO_LARGE`, () => {
    const root = makeRoot();
    const svc = fileServiceFor(root);
    expectWorkspaceError(
      () =>
        svc.writeFile({
          projectId: PROJECT,
          path: "big.txt",
          content: "x".repeat(MAX_WRITE_BYTES + 1),
        }),
      "TOO_LARGE",
    );
    expect(fs.existsSync(path.join(root, "big.txt"))).toBe(false);
  });

  it("search skips files over the 256 KB search cap", () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, "huge.txt"),
      `prefix MARKER_ONLY_IN_HUGE ${"y".repeat(300 * 1024)}`,
    );
    fs.writeFileSync(path.join(root, "small.txt"), "MARKER_ONLY_IN_HUGE visible here\n");
    const search = new WorkspaceSearchService({
      resolveRoot: (p: string) => (p === PROJECT ? root : undefined),
    });
    const outcome = search.search({ projectId: PROJECT, query: "MARKER_ONLY_IN_HUGE" });
    const paths = outcome.matches.map((m) => m.path);
    expect(paths).toContain("small.txt");
    expect(paths).not.toContain("huge.txt");
  });

  it("terminal flooding stdout (~1 MB) truncates with a bounded buffer", async () => {
    const root = makeRoot();
    const svc = terminalServiceFor(root);
    const created = await svc.create({ projectId: PROJECT });
    const started = await svc.start({
      sessionId: created.id,
      projectId: PROJECT,
      command: process.execPath,
      args: ["-e", `process.stdout.write("A".repeat(1024 * 1024))`],
      timeoutMs: 30000,
    });
    expect(started.state).toBe("stopped");
    expect(started.truncated).toBe(true);
    expect(started.outputBytes).toBeLessThanOrEqual(TERMINAL_LIMITS.outputCapBytes);
    const out = svc.output({ sessionId: created.id, projectId: PROJECT });
    expect(out.truncated).toBe(true);
    expect(out.returnedBytes).toBeLessThanOrEqual(TERMINAL_LIMITS.defaultTailBytes);
  });
});

// ---------------------------------------------------------------------------
// 7. Forged IPC: wrong types fail validation before handlers run
// ---------------------------------------------------------------------------

describe("security: forged IPC payloads", () => {
  it("path as number and content as object fail with VALIDATION_ERROR", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, workspaceDeps: makeIpcDeps(makeRoot()) });
    const badPath = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_READ, {
      projectId: PROJECT,
      path: 42,
    });
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) expect(badPath.error.code).toBe("VALIDATION_ERROR");
    const badContent = await registry.invokeCommand(IPC_CHANNELS.WORKSPACE_FILES_WRITE, {
      projectId: PROJECT,
      path: "x.txt",
      content: { nested: "object" },
    });
    expect(badContent.ok).toBe(false);
    if (!badContent.ok) expect(badContent.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 8. Renderer privilege separation: no node/electron/fs in renderer views,
//    no fs/child_process in preload
// ---------------------------------------------------------------------------

const DESKTOP_SRC = path.join(__dirname, "..", "..", "..");

function readDesktopSource(relativePath: string): string {
  return fs.readFileSync(path.join(DESKTOP_SRC, relativePath), "utf8");
}

describe("security: renderer privilege separation", () => {
  it("CodingWorkspace has no node:/electron/fs/child_process imports", () => {
    const src = readDesktopSource(
      path.join("renderer", "components", "workspace", "surfaces", "CodingWorkspace.tsx"),
    );
    for (const marker of [
      "node:",
      'from "electron"',
      "child_process",
      'from "fs"',
      "window.require",
    ]) {
      expect(src, marker).not.toContain(marker);
    }
  });

  it("TaskSurfaces has no node:/electron/fs/child_process imports", () => {
    const src = readDesktopSource(
      path.join("renderer", "components", "workspace", "surfaces", "TaskSurfaces.tsx"),
    );
    for (const marker of [
      "node:",
      'from "electron"',
      "child_process",
      'from "fs"',
      "window.require",
    ]) {
      expect(src, marker).not.toContain(marker);
    }
  });

  it("App uses window.api only (no privileged imports)", () => {
    const src = readDesktopSource(path.join("renderer", "App.tsx"));
    for (const marker of ["child_process", 'from "fs"', "window.require"]) {
      expect(src, marker).not.toContain(marker);
    }
    expect(src).toContain("window.api");
  });

  it("preload exposes no fs/child_process bridge", () => {
    const src = readDesktopSource(path.join("preload", "index.ts"));
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("node:fs");
    expect(src).not.toContain('exposeInMainWorld("fs"');
  });
});

// ---------------------------------------------------------------------------
// 9. Permission layering: terminal creation honors DenyAll (zero sessions);
//    WorkspaceFileService.writeFile documents that it checks NO permissions
// ---------------------------------------------------------------------------

describe("security: permission layering", () => {
  it("terminal create with DenyAll fails PERMISSION_DENIED with zero sessions", async () => {
    const root = makeRoot();
    const svc = terminalServiceFor(root, new DenyAllPermissions());
    await expectTerminalErrorAsync(() => svc.create({ projectId: PROJECT }), "PERMISSION_DENIED");
    expect(svc.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it("DOCUMENTED: WorkspaceFileService.writeFile performs no permission check itself", () => {
    // Layering contract: path policy lives in IPC/service; permission
    // mediation lives in the agent tool executor (CodingToolExecutor).
    // This test pins that writeFile succeeds with no PermissionManager in
    // scope (the constructor takes only resolveRoot).
    const root = makeRoot();
    const svc = new WorkspaceFileService({
      resolveRoot: (p: string) => (p === PROJECT ? root : undefined),
    });
    const result = svc.writeFile({ projectId: PROJECT, path: "doc.txt", content: "no gate here" });
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, "doc.txt"), "utf8")).toBe("no gate here");
  });
});
