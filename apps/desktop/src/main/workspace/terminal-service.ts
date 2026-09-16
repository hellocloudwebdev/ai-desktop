// PR41: apps/desktop — Workspace Terminal Service
//
// Managed terminal sessions backed by the canonical ExecutionManager
// (DefaultExecutionManager + SandboxProvider). No pty, no xterm, no new
// dependencies: a "terminal" here is a managed one-shot / long-running
// execution with a bounded output buffer and a pollable tail snapshot.
//
// Honest boundaries (verified against the PR41 sources before writing):
//   1. One-shot model — ExecutionManager.execute() resolves with the FULL
//      result only at completion; there is no incremental streaming API.
//      output() is therefore a pollable bounded tail snapshot ("streaming via
//      polling" = the renderer polls output()). A running session reports
//      whatever is buffered (empty until its execution completes).
//   2. NO interactive stdin — write() FAILS CLOSED with STDIN_UNSUPPORTED.
//      ExecutionManager has no stdin channel; accepting input would fake a
//      terminal that cannot exist in PR41.
//   3. NO caller env — start() takes no env at all. The LocalProcessSandbox
//      provider allowlists PATH/SYSTEMROOT/TMP/TEMP plus session defaults;
//      this service never passes environmentVariables, so renderer-facing
//      errors can never leak env values.
//   4. Timeout is enforced by the ExecutionManager/provider (hard wall-clock
//      kill). No service-level watchdog (manager timeout suffices).
//   5. No secret scanning of output — buffered output may contain secrets the
//      USER themselves ran; that is their terminal.
//   6. Permission gate mirrors coding-tools builtin:execution.run exactly:
//      capability via codingCapabilityFor("builtin:execution.run")
//      ("execution.run"), action "execute", scope "once", risk high, a fresh
//      relatedToolCallId, options { projectId }. Resource is terminal-scoped:
//      `terminal::<projectId>::<requested-cwd>` (requested cwd, mirroring how
//      codingResourceFor embeds the requested cwd — never a resolved path).
//      Deny AND requires_user both fail closed with PERMISSION_DENIED (the
//      service cannot prompt). NOTE: DefaultExecutionManager ALSO gates
//      internally when constructed with a permissionManager; that inner gate
//      returns exitCode 126 (it never throws) and surfaces here as failed.
//   7. Terminal states: stopped = clean exit 0; failed = nonzero exit /
//      timedOut / dispatch error; cancelled = halted via stop()/cancel()/
//      shutdown(). stop() therefore converges stopping -> cancelled (the
//      honest state for an aborted execution), never "stopped".
//   8. shutdown() is exported only; it is NOT wired into main/index.ts —
//      wiring lands in a later step (see final PR report).
//  9. Stopped/failed/cancelled sessions are retained until shutdown() (no
//      dispose API in PR41) and still count toward the per-project cap.

import {
  codingCapabilityFor,
  codingRiskFor,
  createExecutionId,
  type ExecutionId,
  type ExecutionResult,
} from "@ai-desktop/ai-core";
import type { DefaultExecutionManager } from "@ai-desktop/execution";
import type { PermissionManager } from "@ai-desktop/permissions";
import { BaseError, createToolCallId, generateUlid, now, type Brand } from "@ai-desktop/shared";
import { PathPolicyError, resolveWorkspacePath } from "../agent/filesystem/path-policy.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Branded terminal session id (local ULID; distinct from execution SessionId). */
export type TerminalSessionId = Brand<string, "TerminalSessionId">;

export function createTerminalSessionId(): TerminalSessionId {
  return generateUlid() as TerminalSessionId;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TerminalErrorCode =
  | "INVALID_STATE"
  | "PERMISSION_DENIED"
  | "SESSION_LIMIT"
  | "STDIN_UNSUPPORTED"
  | "NOT_FOUND"
  | "INVALID_CWD"
  | "INVALID_COMMAND"
  | "INVALID_SIZE"
  | "INVALID_PROJECT"
  | "NO_WORKSPACE";

export class TerminalError extends BaseError {
  constructor(
    readonly terminalCode: TerminalErrorCode,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(terminalCode, message, options);
    this.name = "TerminalError";
  }
}

export function isTerminalError(value: unknown): value is TerminalError {
  return value instanceof TerminalError;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type TerminalState =
  "created" | "starting" | "running" | "stopping" | "stopped" | "failed" | "cancelled";

export const VALID_TERMINAL_TRANSITIONS: Readonly<Record<TerminalState, readonly TerminalState[]>> =
  {
    created: ["starting", "stopping"],
    starting: ["running", "failed", "stopping"],
    running: ["stopping", "stopped", "failed"],
    stopping: ["stopped", "failed", "cancelled"],
    stopped: [],
    failed: [],
    cancelled: [],
  };

const TERMINAL_STATES: ReadonlySet<TerminalState> = new Set([
  "created",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "cancelled",
]);

export function isTerminalState(state: TerminalState): boolean {
  return state === "stopped" || state === "failed" || state === "cancelled";
}

/** Throws TerminalError INVALID_STATE unless from -> to is a legal edge. */
export function validateTerminalTransition(from: TerminalState, to: TerminalState): void {
  if (!TERMINAL_STATES.has(from) || !TERMINAL_STATES.has(to)) {
    throw new TerminalError(
      "INVALID_STATE",
      `Unknown terminal state in transition "${String(from)}" -> "${String(to)}"`,
    );
  }
  if (!VALID_TERMINAL_TRANSITIONS[from].includes(to)) {
    throw new TerminalError("INVALID_STATE", `Invalid terminal transition "${from}" -> "${to}"`, {
      details: { from, to },
    });
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const TERMINAL_LIMITS = {
  maxSessionsPerProject: 8,
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 120000,
  outputCapBytes: 256 * 1024,
  outputKeepBytes: 200 * 1024,
  defaultTailBytes: 32 * 1024,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 100,
  defaultCols: 80,
  defaultRows: 24,
} as const;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface TerminalSnapshot {
  readonly id: TerminalSessionId;
  readonly projectId: string;
  readonly cwd: string;
  readonly state: TerminalState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly droppedBytes: number;
  readonly outputBytes: number;
  readonly error?: string;
}

export interface TerminalOutput {
  readonly sessionId: TerminalSessionId;
  readonly state: TerminalState;
  readonly text: string;
  readonly totalBytes: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

export interface CreateTerminalOptions {
  readonly projectId: string;
  readonly cwd?: string;
}

export interface StartTerminalOptions {
  readonly sessionId: TerminalSessionId;
  readonly projectId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface TerminalRef {
  readonly sessionId: TerminalSessionId;
  readonly projectId: string;
}

export interface WriteTerminalOptions extends TerminalRef {
  readonly input: string;
}

export interface ResizeTerminalOptions extends TerminalRef {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalOutputOptions extends TerminalRef {
  readonly tailBytes?: number;
}

export interface ListTerminalsOptions {
  readonly projectId: string;
}

export interface TerminalServiceDeps {
  readonly executionManager: DefaultExecutionManager;
  readonly resolveRoot: (projectId: string) => string | undefined;
  readonly permissionManager: PermissionManager;
}

interface OutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

interface TerminalRecord {
  readonly id: TerminalSessionId;
  readonly projectId: string;
  readonly cwdRequested: string;
  readonly cwdReal: string;
  readonly createdAt: number;
  state: TerminalState;
  updatedAt: number;
  cols: number;
  rows: number;
  chunks: OutputChunk[];
  outputBytes: number;
  truncated: boolean;
  droppedBytes: number;
  execIds: ExecutionId[];
  currentExecutionId?: ExecutionId;
  controller?: AbortController;
  exitCode?: number;
  timedOut: boolean;
  error?: string;
}

/**
 * PR41 workspace terminal service. Owns session lifecycle, permission gating,
 * and the bounded output buffer; execution itself stays in ExecutionManager.
 */
export class TerminalService {
  private readonly _executionManager: DefaultExecutionManager;
  private readonly _resolveRoot: (projectId: string) => string | undefined;
  private readonly _permissionManager: PermissionManager;
  private readonly _sessions = new Map<TerminalSessionId, TerminalRecord>();

  constructor(deps: TerminalServiceDeps) {
    this._executionManager = deps.executionManager;
    this._resolveRoot = deps.resolveRoot;
    this._permissionManager = deps.permissionManager;
  }

  // -- lifecycle ------------------------------------------------------------

  async create(options: CreateTerminalOptions): Promise<TerminalSnapshot> {
    const projectId = options.projectId;
    if (typeof projectId !== "string" || projectId.trim().length === 0) {
      throw new TerminalError("INVALID_PROJECT", "projectId must be a non-empty string");
    }
    const root = this._resolveRoot(projectId);
    if (!root) {
      throw new TerminalError("NO_WORKSPACE", "No workspace is registered for this project", {
        details: { projectId },
      });
    }
    const cwdRequested = options.cwd === undefined ? "." : options.cwd;
    if (typeof cwdRequested !== "string" || cwdRequested.trim().length === 0) {
      throw new TerminalError("INVALID_CWD", "cwd must be a non-empty string");
    }
    let cwdReal: string;
    try {
      cwdReal = resolveWorkspacePath(root, cwdRequested).targetReal;
    } catch (err: unknown) {
      throw new TerminalError("INVALID_CWD", "Working directory escapes the workspace", {
        cause: err instanceof Error ? err : undefined,
        details: err instanceof PathPolicyError ? { policyCode: err.code } : undefined,
      });
    }

    let projectCount = 0;
    for (const rec of this._sessions.values()) {
      if (rec.projectId === projectId) projectCount += 1;
    }
    if (projectCount >= TERMINAL_LIMITS.maxSessionsPerProject) {
      throw new TerminalError(
        "SESSION_LIMIT",
        `Terminal session limit reached (${TERMINAL_LIMITS.maxSessionsPerProject} per project)`,
        { details: { projectId } },
      );
    }

    // Terminal execution = execution.run semantics; mirror the coding-tools
    // permission check shape exactly (capability/action/scope/risk/ids).
    const permResult = await this._permissionManager.check(
      {
        capability: codingCapabilityFor("builtin:execution.run"),
        action: "execute",
        resource: `terminal::${projectId}::${cwdRequested}`,
        scope: "once",
        risk: codingRiskFor("execution.run"),
        relatedToolCallIds: [createToolCallId()],
      },
      { projectId },
    );
    if (permResult.kind !== "allow") {
      throw new TerminalError("PERMISSION_DENIED", "Terminal creation denied by policy", {
        details: {
          kind: permResult.kind,
          ...(permResult.kind === "deny" && permResult.reason ? { reason: permResult.reason } : {}),
        },
      });
    }

    const nowMs = Date.now();
    const record: TerminalRecord = {
      id: createTerminalSessionId(),
      projectId,
      cwdRequested,
      cwdReal,
      createdAt: nowMs,
      state: "created",
      updatedAt: nowMs,
      cols: TERMINAL_LIMITS.defaultCols,
      rows: TERMINAL_LIMITS.defaultRows,
      chunks: [],
      outputBytes: 0,
      truncated: false,
      droppedBytes: 0,
      execIds: [],
      timedOut: false,
    };
    this._sessions.set(record.id, record);
    return this._snapshot(record);
  }

  async start(options: StartTerminalOptions): Promise<TerminalSnapshot> {
    const record = this._require(options.projectId, options.sessionId);
    if (typeof options.command !== "string" || options.command.trim().length === 0) {
      throw new TerminalError("INVALID_COMMAND", "command must be a non-empty string");
    }
    const args = options.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new TerminalError("INVALID_COMMAND", "args must be an array of strings");
    }
    const rawTimeout = options.timeoutMs;
    const timeoutMs =
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(Math.floor(rawTimeout), TERMINAL_LIMITS.maxTimeoutMs)
        : TERMINAL_LIMITS.defaultTimeoutMs;

    this._transition(record, "starting");

    const executionId = createExecutionId();
    record.execIds.push(executionId);
    record.currentExecutionId = executionId;
    const controller = new AbortController();
    record.controller = controller;

    // No environmentVariables: provider allowlist + session defaults apply.
    const request = {
      id: executionId,
      relatedToolCallId: createToolCallId(),
      mode: "sandboxed" as const,
      command: options.command,
      args: [...args],
      workingDirectory: record.cwdReal,
      resourceLimits: { timeoutMs, networkAllowed: false },
      timestamp: now(),
      metadata: { projectId: record.projectId, terminalSessionId: record.id },
    };

    this._transition(record, "running");

    let result: ExecutionResult;
    try {
      result = await this._executionManager.execute(request, controller.signal);
    } catch (err: unknown) {
      // Defensive: the provider resolves rather than throws, but a stop()
      // racing completion must never resurrect the session.
      if (isTerminalState(record.state)) return this._snapshot(record);
      record.error = err instanceof Error ? err.message : String(err);
      this._transition(record, "failed");
      this._finalize(record);
      return this._snapshot(record);
    }

    // A racing stop()/shutdown() already converged this session; the late
    // result is discarded rather than overwriting the terminal state.
    if (record.state !== "running" || record.currentExecutionId !== executionId) {
      return this._snapshot(record);
    }
    this._appendOutput(record, "stdout", result.stdout);
    this._appendOutput(record, "stderr", result.stderr);
    record.exitCode = result.exitCode;
    record.timedOut = result.timedOut;
    if (!result.timedOut && result.exitCode === 0) {
      this._transition(record, "stopped");
    } else {
      record.error = result.timedOut
        ? `Execution timed out after ${timeoutMs}ms`
        : `Execution failed with exit code ${result.exitCode}`;
      this._transition(record, "failed");
    }
    this._finalize(record);
    return this._snapshot(record);
  }

  /**
   * FAIL CLOSED: the ExecutionManager one-shot model exposes no stdin
   * channel, so interactive input is out of scope for PR41. Always throws
   * STDIN_UNSUPPORTED (after resolving the session, so unknown ids still
   * report NOT_FOUND rather than leaking session existence details).
   */
  async write(options: WriteTerminalOptions): Promise<never> {
    this._require(options.projectId, options.sessionId);
    throw new TerminalError("STDIN_UNSUPPORTED", "interactive stdin is out of scope for PR41");
  }

  /**
   * Stores viewport dimensions for a future pty; inert today (no-op effect
   * beyond the record). Bounds: cols 20..500, rows 5..100.
   */
  async resize(options: ResizeTerminalOptions): Promise<TerminalSnapshot> {
    const record = this._require(options.projectId, options.sessionId);
    if (
      !Number.isInteger(options.cols) ||
      options.cols < TERMINAL_LIMITS.minCols ||
      options.cols > TERMINAL_LIMITS.maxCols
    ) {
      throw new TerminalError(
        "INVALID_SIZE",
        `cols must be an integer in ${TERMINAL_LIMITS.minCols}..${TERMINAL_LIMITS.maxCols}`,
      );
    }
    if (
      !Number.isInteger(options.rows) ||
      options.rows < TERMINAL_LIMITS.minRows ||
      options.rows > TERMINAL_LIMITS.maxRows
    ) {
      throw new TerminalError(
        "INVALID_SIZE",
        `rows must be an integer in ${TERMINAL_LIMITS.minRows}..${TERMINAL_LIMITS.maxRows}`,
      );
    }
    record.cols = options.cols;
    record.rows = options.rows;
    record.updatedAt = Date.now();
    return this._snapshot(record);
  }

  /**
   * Halts a session: running/starting/created -> stopping -> cancelled.
   * Idempotent: already-terminal sessions return their snapshot unchanged.
   */
  async stop(ref: TerminalRef): Promise<TerminalSnapshot> {
    const record = this._require(ref.projectId, ref.sessionId);
    if (isTerminalState(record.state)) return this._snapshot(record);
    this._transition(record, "stopping");
    try {
      record.controller?.abort();
    } catch {
      // Abort must never block convergence on _finalize.
    }
    const executionId = record.currentExecutionId;
    record.currentExecutionId = undefined;
    if (executionId !== undefined) {
      try {
        await this._executionManager.cancel(executionId);
      } catch {
        // Best-effort: the provider kill already went out via AbortSignal.
      }
    }
    this._transition(record, "cancelled");
    this._finalize(record);
    return this._snapshot(record);
  }

  /** Alias for stop(): external halt converges on "cancelled". */
  async cancel(ref: TerminalRef): Promise<TerminalSnapshot> {
    return this.stop(ref);
  }

  get(ref: TerminalRef): TerminalSnapshot {
    return this._snapshot(this._require(ref.projectId, ref.sessionId));
  }

  list(options: ListTerminalsOptions): TerminalSnapshot[] {
    const out: TerminalSnapshot[] = [];
    for (const record of this._sessions.values()) {
      if (record.projectId === options.projectId) out.push(this._snapshot(record));
    }
    return out;
  }

  output(options: TerminalOutputOptions): TerminalOutput {
    const record = this._require(options.projectId, options.sessionId);
    const rawTail = options.tailBytes;
    const tailBytes =
      typeof rawTail === "number" && Number.isFinite(rawTail) && rawTail > 0
        ? Math.floor(rawTail)
        : TERMINAL_LIMITS.defaultTailBytes;
    const full = record.chunks.map((c) => c.text).join("");
    const fullBytes = Buffer.byteLength(full, "utf8");
    const text =
      fullBytes <= tailBytes
        ? full
        : Buffer.from(full, "utf8")
            .subarray(fullBytes - tailBytes)
            .toString("utf8");
    return {
      sessionId: record.id,
      state: record.state,
      text,
      totalBytes: record.outputBytes,
      returnedBytes: Buffer.byteLength(text, "utf8"),
      truncated: record.truncated,
      droppedBytes: record.droppedBytes,
    };
  }

  /**
   * Halts every non-terminal session (idempotent; safe for app shutdown).
   * Exported only — NOT wired into main/index.ts in PR41 (later step).
   */
  async shutdown(): Promise<TerminalSnapshot[]> {
    const results: TerminalSnapshot[] = [];
    for (const record of this._sessions.values()) {
      if (isTerminalState(record.state)) {
        results.push(this._snapshot(record));
      } else {
        results.push(await this.stop({ sessionId: record.id, projectId: record.projectId }));
      }
    }
    return results;
  }

  // -- internals ------------------------------------------------------------

  /**
   * Single lookup point: unknown ids AND cross-project access both report
   * NOT_FOUND (no existence oracle across project boundaries).
   */
  private _require(projectId: string, sessionId: TerminalSessionId): TerminalRecord {
    const record = this._sessions.get(sessionId);
    if (!record || record.projectId !== projectId) {
      throw new TerminalError("NOT_FOUND", "Terminal session not found");
    }
    return record;
  }

  private _transition(record: TerminalRecord, to: TerminalState): void {
    validateTerminalTransition(record.state, to);
    record.state = to;
    record.updatedAt = Date.now();
  }

  /**
   * Convergence point: every completion path (natural finish, dispatch
   * error, stop, shutdown) releases the controller and clears the active
   * execution so no path can resurrect or leak a session.
   */
  private _finalize(record: TerminalRecord): void {
    record.controller = undefined;
    record.currentExecutionId = undefined;
    record.updatedAt = Date.now();
  }

  /**
   * Bounded buffer: 256KB total cap, keeps the TAIL (last 200KB) on
   * overflow, records truncated + droppedBytes. No secret scanning — the
   * buffered output is the user's own terminal output.
   */
  private _appendOutput(record: TerminalRecord, stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text, "utf8");
    record.chunks.push({ stream, text });
    record.outputBytes += bytes;
    if (record.outputBytes <= TERMINAL_LIMITS.outputCapBytes) return;
    let over = record.outputBytes - TERMINAL_LIMITS.outputKeepBytes;
    while (over > 0 && record.chunks.length > 0) {
      const head = record.chunks[0];
      if (!head) break;
      const headBytes = Buffer.byteLength(head.text, "utf8");
      if (headBytes <= over) {
        record.chunks.shift();
        record.outputBytes -= headBytes;
        record.droppedBytes += headBytes;
        over -= headBytes;
      } else {
        head.text = Buffer.from(head.text, "utf8").subarray(over).toString("utf8");
        record.outputBytes -= over;
        record.droppedBytes += over;
        over = 0;
      }
    }
    record.truncated = true;
  }

  private _snapshot(record: TerminalRecord): TerminalSnapshot {
    return {
      id: record.id,
      projectId: record.projectId,
      cwd: record.cwdReal,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cols: record.cols,
      rows: record.rows,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      timedOut: record.timedOut,
      truncated: record.truncated,
      droppedBytes: record.droppedBytes,
      outputBytes: record.outputBytes,
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }
}
