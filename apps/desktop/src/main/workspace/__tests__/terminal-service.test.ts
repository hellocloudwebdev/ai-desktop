// PR41: apps/desktop — TerminalService tests
//
// REAL DefaultExecutionManager + REAL LocalProcessSandboxProvider (no pty,
// no xterm, no new dependencies). Portable commands only: the runtime's own
// `process.execPath -e "..."` for echo/sleep — node IS the runtime, so this
// adds no dependency and works on win32/POSIX alike.
//
// NOTE (report): terminal:* IPC channels are NOT yet in
// packages/shared/src/ipc-contract.ts (parallel agent's workspace). The
// command schemas below are LOCAL structural definitions for documentation
// value only; shared/ipc-contract.ts was deliberately NOT edited.
//
// NOTE: DefaultExecutionManager is constructed WITHOUT a permissionManager
// here (only the sandbox provider + default workspace). The TerminalService
// performs its own permission gate up front; passing the same allow-all
// manager into the inner manager would double-check every execution.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";
import {
  createExecutionId,
  type ExecutionId,
  type ExecutionRequest,
  type ExecutionResult,
  type PermissionCheck,
  type PermissionDecisionResult,
  type PermissionRequest,
  type PermissionRequestId,
} from "@ai-desktop/ai-core";
import type { PermissionManager, PermissionPolicy } from "@ai-desktop/permissions";
import { now, type ToolCallId } from "@ai-desktop/shared";
import {
  TERMINAL_LIMITS,
  TerminalError,
  TerminalService,
  VALID_TERMINAL_TRANSITIONS,
  isTerminalError,
  validateTerminalTransition,
  type TerminalServiceDeps,
  type TerminalSessionId,
} from "../terminal-service.js";

// ---------------------------------------------------------------------------
// Local structural terminal:* command schemas (DOCUMENTATION ONLY — the real
// channel contracts land in shared/ipc-contract.ts via the parallel agent).
// ---------------------------------------------------------------------------

const TerminalIpcChannels = {
  create: "terminal:create",
  start: "terminal:start",
  write: "terminal:write",
  resize: "terminal:resize",
  stop: "terminal:stop",
  get: "terminal:get",
  list: "terminal:list",
  output: "terminal:output",
} as const;

interface TerminalIpcCommandShapes {
  "terminal:create": { projectId: string; cwd?: string };
  "terminal:start": {
    projectId: string;
    sessionId: string;
    command: string;
    args?: string[];
    timeoutMs?: number;
  };
  "terminal:write": { projectId: string; sessionId: string; input: string };
  "terminal:resize": { projectId: string; sessionId: string; cols: number; rows: number };
  "terminal:stop": { projectId: string; sessionId: string };
  "terminal:get": { projectId: string; sessionId: string };
  "terminal:list": { projectId: string };
  "terminal:output": { projectId: string; sessionId: string; tailBytes?: number };
}

function assertShape<K extends keyof TerminalIpcCommandShapes>(
  channel: K,
  value: TerminalIpcCommandShapes[K],
): TerminalIpcCommandShapes[K] {
  expect(Object.values(TerminalIpcChannels)).toContain(channel);
  return value;
}

// ---------------------------------------------------------------------------
// Fakes: permission managers + controllable execution manager
// ---------------------------------------------------------------------------

class AllowAllPermissions implements PermissionManager {
  readonly checks: PermissionCheck[] = [];
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
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
    this.checks.push(request);
    return { kind: "deny", reason: "Denied in test" };
  }
}

class RequiresUserPermissions extends AllowAllPermissions {
  override async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return {
      kind: "requires_user",
      request: {
        id: "01K6TESTREQUEST000000000001" as PermissionRequestId,
        relatedToolCallIds: ["01K6TESTTOOLCALL0000000001" as ToolCallId],
        capability: request.capability,
        action: request.action,
        resource: request.resource,
        scope: "once",
        risk: "high",
        status: "pending",
        createdAt: now(),
      },
    };
  }
}

/**
 * Controllable stub: deferred execute() lets tests hold a session in
 * running and observe lifecycle races deterministically.
 */
class DeferredExecutionManager {
  readonly requests: ExecutionRequest[] = [];
  readonly cancelled: ExecutionId[] = [];
  private _resolvers: Array<(r: ExecutionResult) => void> = [];
  private _next: ExecutionResult | null = null;

  queue(result: ExecutionResult): void {
    const pending = this._resolvers.shift();
    if (pending) pending(result);
    else this._next = result;
  }

  /** Settles every still-pending execute() (lets stop/shutdown tests drain). */
  resolveAll(result: ExecutionResult): void {
    for (const resolve of this._resolvers.splice(0)) resolve(result);
  }

  get pendingCount(): number {
    return this._resolvers.length;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(request);
    const queued = this._next;
    this._next = null;
    if (queued) return { ...queued, executionId: request.id };
    return new Promise<ExecutionResult>((resolve) => {
      this._resolvers.push((r) => resolve({ ...r, executionId: request.id }));
    });
  }

  async cancel(executionId: ExecutionId): Promise<boolean> {
    this.cancelled.push(executionId);
    return true;
  }
}

function okResult(stdout = "ok"): ExecutionResult {
  return {
    executionId: createExecutionId(),
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    timestamp: now(),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PROJ = "proj-A";
const OTHER_PROJ = "proj-B";

let root: string;
let otherRoot: string;
let allow: AllowAllPermissions;
let realManager: DefaultExecutionManager;

function makeRealDeps(pm: PermissionManager = allow): TerminalServiceDeps {
  return {
    executionManager: realManager,
    resolveRoot: (projectId: string) =>
      projectId === PROJ ? root : projectId === OTHER_PROJ ? otherRoot : undefined,
    permissionManager: pm,
  };
}

/** Portable echo via the runtime itself (no shell, no extra dependency). */
function echoArgs(text: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
  };
}

/** Portable sleep-then-print via the runtime itself. */
function sleepArgs(ms: number): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", `setTimeout(()=>process.stdout.write("done"), ${ms})`],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-ws-"));
  otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-ws-other-"));
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  allow = new AllowAllPermissions();
  realManager = new DefaultExecutionManager({
    sandboxProvider: new LocalProcessSandboxProvider(),
    defaultWorkspacePath: root,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(otherRoot, { recursive: true, force: true });
});

async function createAndStart(
  svc: TerminalService,
  command: string,
  args: string[] = [],
  extra: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ sessionId: TerminalSessionId }> {
  const created = await svc.create({ projectId: PROJ, ...(extra.cwd ? { cwd: extra.cwd } : {}) });
  const started = await svc.start({
    sessionId: created.id,
    projectId: PROJ,
    command,
    args,
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return { sessionId: started.id };
}

// ---------------------------------------------------------------------------
// IPC schema presence note (structural, local)
// ---------------------------------------------------------------------------

describe("apps/desktop: terminal IPC channels (PR41 local structural note)", () => {
  it("documents the eight terminal:* channel shapes locally (shared/ipc-contract.ts untouched)", () => {
    const create = assertShape(TerminalIpcChannels.create, { projectId: PROJ, cwd: "." });
    expect(create.projectId).toBe(PROJ);
    assertShape(TerminalIpcChannels.start, {
      projectId: PROJ,
      sessionId: "s",
      command: "echo",
      args: ["hi"],
      timeoutMs: 1000,
    });
    assertShape(TerminalIpcChannels.write, { projectId: PROJ, sessionId: "s", input: "x\n" });
    assertShape(TerminalIpcChannels.resize, {
      projectId: PROJ,
      sessionId: "s",
      cols: 80,
      rows: 24,
    });
    assertShape(TerminalIpcChannels.stop, { projectId: PROJ, sessionId: "s" });
    assertShape(TerminalIpcChannels.get, { projectId: PROJ, sessionId: "s" });
    assertShape(TerminalIpcChannels.list, { projectId: PROJ });
    assertShape(TerminalIpcChannels.output, { projectId: PROJ, sessionId: "s", tailBytes: 100 });
    expect(Object.keys(TerminalIpcChannels)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle happy path (real manager + provider)
// ---------------------------------------------------------------------------

describe("apps/desktop: TerminalService lifecycle (PR41)", () => {
  it("create -> start(echo) -> stopped with buffered output, snapshot carries exitCode 0", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    expect(created.state).toBe("created");
    expect(created.cwd).toBe(fs.realpathSync(root));

    const { command, args } = echoArgs("hello-terminal");
    const started = await svc.start({
      sessionId: created.id,
      projectId: PROJ,
      command,
      args,
    });
    expect(started.state).toBe("stopped");
    expect(started.exitCode).toBe(0);
    expect(started.timedOut).toBe(false);
    expect(started.outputBytes).toBeGreaterThan(0);

    const out = svc.output({ sessionId: created.id, projectId: PROJ });
    expect(out.text).toContain("hello-terminal");
    expect(out.state).toBe("stopped");
    expect(out.truncated).toBe(false);
  });

  it("create resolves a subdirectory cwd inside the workspace", async () => {
    const svc = new TerminalService(makeRealDeps());
    const snap = await svc.create({ projectId: PROJ, cwd: "sub" });
    expect(snap.cwd).toBe(fs.realpathSync(path.join(root, "sub")));
  });

  it("get/list scope to the project; list excludes other projects", async () => {
    const svc = new TerminalService(makeRealDeps());
    await svc.create({ projectId: PROJ });
    await svc.create({ projectId: OTHER_PROJ });
    expect(svc.list({ projectId: PROJ })).toHaveLength(1);
    expect(svc.list({ projectId: OTHER_PROJ })).toHaveLength(1);
    expect(svc.list({ projectId: "nope" })).toHaveLength(0);
  });

  it("shutdown stops running sessions and is idempotent", async () => {
    const deferred = new DeferredExecutionManager();
    const svc = new TerminalService({
      executionManager: deferred as unknown as DefaultExecutionManager,
      resolveRoot: (p) => (p === PROJ ? root : undefined),
      permissionManager: allow,
    });
    const a = await svc.create({ projectId: PROJ });
    const b = await svc.create({ projectId: PROJ });
    const pa = svc.start({ sessionId: a.id, projectId: PROJ, command: "sleep", args: ["9"] });
    const pb = svc.start({ sessionId: b.id, projectId: PROJ, command: "sleep", args: ["9"] });
    // Wait until both executions are parked in the deferred stub, then halt.
    for (let i = 0; i < 100 && deferred.pendingCount < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deferred.pendingCount).toBe(2);
    const first = await svc.shutdown();
    expect(first.every((s) => s.state === "cancelled")).toBe(true);
    // Late results must not resurrect either session.
    deferred.resolveAll(okResult("late"));
    await Promise.all([pa, pb]);
    const second = await svc.shutdown();
    expect(second.map((s) => s.state)).toEqual(first.map((s) => s.state));
  });

  it("permission check mirrors coding-tools execution.run shape", async () => {
    const svc = new TerminalService(makeRealDeps());
    await svc.create({ projectId: PROJ, cwd: "sub" });
    expect(allow.checks).toHaveLength(1);
    const check = allow.checks[0];
    if (!check) throw new Error("expected a permission check");
    expect(check.capability).toBe("execution.run");
    expect(check.action).toBe("execute");
    expect(check.resource).toBe(`terminal::${PROJ}::sub`);
    expect(check.scope).toBe("once");
    expect(check.risk).toBe("high");
    expect(check.relatedToolCallIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Denials and containment
// ---------------------------------------------------------------------------

describe("apps/desktop: TerminalService permission + cwd gates (PR41)", () => {
  it("permission deny creates NO session (count unchanged)", async () => {
    const svc = new TerminalService(makeRealDeps(new DenyAllPermissions()));
    await expect(svc.create({ projectId: PROJ })).rejects.toMatchObject({
      name: "TerminalError",
      terminalCode: "PERMISSION_DENIED",
    });
    expect(svc.list({ projectId: PROJ })).toHaveLength(0);
  });

  it("requires_user also fails closed with PERMISSION_DENIED", async () => {
    const svc = new TerminalService(makeRealDeps(new RequiresUserPermissions()));
    await expect(svc.create({ projectId: PROJ })).rejects.toMatchObject({
      terminalCode: "PERMISSION_DENIED",
    });
    expect(svc.list({ projectId: PROJ })).toHaveLength(0);
  });

  it("rejects ../ traversal", async () => {
    const svc = new TerminalService(makeRealDeps());
    await expect(svc.create({ projectId: PROJ, cwd: "../escape" })).rejects.toMatchObject({
      terminalCode: "INVALID_CWD",
    });
  });

  it("rejects absolute paths outside the workspace", async () => {
    const svc = new TerminalService(makeRealDeps());
    await expect(
      svc.create({ projectId: PROJ, cwd: path.resolve(os.tmpdir()) }),
    ).rejects.toMatchObject({ terminalCode: "INVALID_CWD" });
  });

  it("rejects symlink directories escaping the workspace", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-outside-"));
    try {
      const link = path.join(root, "evil-link");
      try {
        fs.symlinkSync(outside, link, "dir");
      } catch {
        return; // symlink creation blocked on this platform — containment still covered by traversal tests
      }
      const svc = new TerminalService(makeRealDeps());
      await expect(svc.create({ projectId: PROJ, cwd: "evil-link" })).rejects.toMatchObject({
        terminalCode: "INVALID_CWD",
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("unknown project root reports NO_WORKSPACE", async () => {
    const svc = new TerminalService(makeRealDeps());
    await expect(svc.create({ projectId: "ghost" })).rejects.toMatchObject({
      terminalCode: "NO_WORKSPACE",
    });
  });
});

// ---------------------------------------------------------------------------
// Output ceiling, timeout, exit codes
// ---------------------------------------------------------------------------

describe("apps/desktop: TerminalService output + completion mapping (PR41)", () => {
  it("256KB ceiling keeps the TAIL: truncated=true with droppedBytes>0", async () => {
    const svc = new TerminalService(makeRealDeps());
    const { sessionId } = await createAndStart(
      svc,
      ...(() => {
        const e = echoArgs("");
        return [e.command, e.args] as const;
      })(),
    );
    expect(svc.get({ sessionId, projectId: PROJ }).state).toBe("stopped");
    // Force a big real output through the runtime itself.
    const big = await svc.create({ projectId: PROJ });
    await svc.start({
      sessionId: big.id,
      projectId: PROJ,
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${300 * 1024}))`],
      timeoutMs: 30000,
    });
    const snap = svc.get({ sessionId: big.id, projectId: PROJ });
    expect(snap.truncated).toBe(true);
    expect(snap.droppedBytes).toBeGreaterThan(0);
    expect(snap.outputBytes).toBeLessThanOrEqual(TERMINAL_LIMITS.outputKeepBytes + 1024);
    // The real provider truncates HEAD-first with a notice appended, so the
    // service buffer holds the tail: 200KB of "x" + the provider notice.
    const tail = svc.output({ sessionId: big.id, projectId: PROJ, tailBytes: 100 });
    expect(tail.text).toContain("truncated to 262,144 bytes");
    expect(tail.truncated).toBe(true);
    expect(sessionId).toBeDefined();
  });

  it("output tailBytes defaults to 32KB and slices the tail", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    const { command, args } = echoArgs(`abc-${"z".repeat(100)}`);
    await svc.start({ sessionId: created.id, projectId: PROJ, command, args });
    const out = svc.output({ sessionId: created.id, projectId: PROJ });
    expect(out.returnedBytes).toBeLessThanOrEqual(TERMINAL_LIMITS.defaultTailBytes);
    const tiny = svc.output({ sessionId: created.id, projectId: PROJ, tailBytes: 3 });
    expect(tiny.text).toBe("zzz");
  });

  it("slow command with tiny timeoutMs -> failed + timedOut", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    const { command, args } = sleepArgs(5000);
    const snap = await svc.start({
      sessionId: created.id,
      projectId: PROJ,
      command,
      args,
      timeoutMs: 200,
    });
    expect(snap.state).toBe("failed");
    expect(snap.timedOut).toBe(true);
    expect(snap.error).toContain("timed out");
  });

  it("timeoutMs is capped at 120s (request reaching the manager carries the cap)", async () => {
    const deferred = new DeferredExecutionManager();
    const svc = new TerminalService({
      executionManager: deferred as unknown as DefaultExecutionManager,
      resolveRoot: (p) => (p === PROJ ? root : undefined),
      permissionManager: allow,
    });
    const created = await svc.create({ projectId: PROJ });
    const pending = svc.start({
      sessionId: created.id,
      projectId: PROJ,
      command: "echo",
      timeoutMs: 999999999,
    });
    deferred.queue(okResult());
    await pending;
    expect(deferred.requests[0]?.resourceLimits?.timeoutMs).toBe(TERMINAL_LIMITS.maxTimeoutMs);
  });

  it("nonzero exit code maps to failed with the exit code preserved", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    const snap = await svc.start({
      sessionId: created.id,
      projectId: PROJ,
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    });
    expect(snap.state).toBe("failed");
    expect(snap.exitCode).toBe(3);
    expect(snap.error).toContain("exit code 3");
  });
});

// ---------------------------------------------------------------------------
// Cancel / stop idempotency, stdin fail-closed, resize, state machine
// ---------------------------------------------------------------------------

describe("apps/desktop: TerminalService controls + state machine (PR41)", () => {
  it("stop() on a running session converges stopping -> cancelled; double-stop idempotent", async () => {
    const deferred = new DeferredExecutionManager();
    const svc = new TerminalService({
      executionManager: deferred as unknown as DefaultExecutionManager,
      resolveRoot: (p) => (p === PROJ ? root : undefined),
      permissionManager: allow,
    });
    const created = await svc.create({ projectId: PROJ });
    const pending = svc.start({ sessionId: created.id, projectId: PROJ, command: "sleep" });
    await Promise.resolve();
    const first = await svc.stop({ sessionId: created.id, projectId: PROJ });
    expect(first.state).toBe("cancelled");
    expect(deferred.cancelled).toHaveLength(1);
    const second = await svc.stop({ sessionId: created.id, projectId: PROJ });
    expect(second.state).toBe("cancelled");
    expect(deferred.cancelled).toHaveLength(1); // no second cancel call
    deferred.queue(okResult("late-arrival"));
    await pending; // late result must not resurrect the session
    expect(svc.get({ sessionId: created.id, projectId: PROJ }).state).toBe("cancelled");
  });

  it("cancel() aliases stop() and is idempotent on terminal states", async () => {
    const svc = new TerminalService(makeRealDeps());
    const { sessionId } = await createAndStart(
      svc,
      ...(() => {
        const e = echoArgs("x");
        return [e.command, e.args] as const;
      })(),
    );
    const snap = await svc.cancel({ sessionId, projectId: PROJ });
    expect(snap.state).toBe("stopped");
  });

  it("write() FAILS CLOSED with STDIN_UNSUPPORTED", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    await expect(
      svc.write({ sessionId: created.id, projectId: PROJ, input: "ls\n" }),
    ).rejects.toMatchObject({
      name: "TerminalError",
      terminalCode: "STDIN_UNSUPPORTED",
      message: "interactive stdin is out of scope for PR41",
    });
    // Unknown ids still report NOT_FOUND (fail-closed ordering).
    await expect(
      svc.write({
        sessionId: "01K6NONEXISTENT000000000001" as TerminalSessionId,
        projectId: PROJ,
        input: "x",
      }),
    ).rejects.toMatchObject({ terminalCode: "NOT_FOUND" });
  });

  it("resize stores bounded dims (no-op effect today); out-of-range rejected", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    expect(created.cols).toBe(80);
    expect(created.rows).toBe(24);
    const resized = await svc.resize({
      sessionId: created.id,
      projectId: PROJ,
      cols: 120,
      rows: 40,
    });
    expect(resized.cols).toBe(120);
    expect(resized.rows).toBe(40);
    await expect(
      svc.resize({ sessionId: created.id, projectId: PROJ, cols: 19, rows: 24 }),
    ).rejects.toMatchObject({ terminalCode: "INVALID_SIZE" });
    await expect(
      svc.resize({ sessionId: created.id, projectId: PROJ, cols: 80, rows: 101 }),
    ).rejects.toMatchObject({ terminalCode: "INVALID_SIZE" });
    // Failed resize leaves the stored dims untouched.
    expect(svc.get({ sessionId: created.id, projectId: PROJ }).cols).toBe(120);
  });

  it("get with a mismatched projectId reports NOT_FOUND (no cross-project read)", async () => {
    const svc = new TerminalService(makeRealDeps());
    const created = await svc.create({ projectId: PROJ });
    expect(() => svc.get({ sessionId: created.id, projectId: OTHER_PROJ })).toThrowError(
      expect.objectContaining({ terminalCode: "NOT_FOUND" }),
    );
    expect(isTerminalError(new TerminalError("NOT_FOUND", "x"))).toBe(true);
  });

  it("validateTerminalTransition accepts the legal graph and rejects the rest", () => {
    for (const [from, tos] of Object.entries(VALID_TERMINAL_TRANSITIONS)) {
      for (const to of tos) {
        expect(() =>
          validateTerminalTransition(from as Parameters<typeof validateTerminalTransition>[0], to),
        ).not.toThrow();
      }
    }
    expect(() => validateTerminalTransition("created", "running")).toThrowError(
      expect.objectContaining({ terminalCode: "INVALID_STATE" }),
    );
    expect(() => validateTerminalTransition("running", "created")).toThrowError(
      expect.objectContaining({ terminalCode: "INVALID_STATE" }),
    );
    expect(() => validateTerminalTransition("stopped", "running")).toThrowError(
      expect.objectContaining({ terminalCode: "INVALID_STATE" }),
    );
    expect(() => validateTerminalTransition("cancelled", "stopped")).toThrowError(
      expect.objectContaining({ terminalCode: "INVALID_STATE" }),
    );
  });

  it("start with an empty command throws INVALID_COMMAND before touching execution", async () => {
    const deferred = new DeferredExecutionManager();
    const svc = new TerminalService({
      executionManager: deferred as unknown as DefaultExecutionManager,
      resolveRoot: (p) => (p === PROJ ? root : undefined),
      permissionManager: allow,
    });
    const created = await svc.create({ projectId: PROJ });
    await expect(
      svc.start({ sessionId: created.id, projectId: PROJ, command: "  " }),
    ).rejects.toMatchObject({ terminalCode: "INVALID_COMMAND" });
    expect(deferred.requests).toHaveLength(0);
    expect(svc.get({ sessionId: created.id, projectId: PROJ }).state).toBe("created");
  });

  it("enforces the 8-session per-project cap", async () => {
    const svc = new TerminalService(makeRealDeps());
    for (let i = 0; i < TERMINAL_LIMITS.maxSessionsPerProject; i += 1) {
      await svc.create({ projectId: PROJ });
    }
    await expect(svc.create({ projectId: PROJ })).rejects.toMatchObject({
      terminalCode: "SESSION_LIMIT",
    });
    // Other projects are unaffected.
    await expect(svc.create({ projectId: OTHER_PROJ })).resolves.toBeDefined();
  });
});
