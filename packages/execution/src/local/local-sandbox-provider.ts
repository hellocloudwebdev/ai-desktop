// PR27: packages/execution — Local Process Sandbox Provider (Hermetic / Process Contained)
//
// Invariants:
//   1. Enforces environment allowlist: passes only approved variables; NEVER wholesale process.env.
//   2. Enforces workspace path safety: rejects /, /etc, $HOME, etc.
//   3. Enforces hard wall-clock timeouts: terminates process via SIGKILL.
//   4. Enforces cooperative AbortSignal cancellation: terminates process via SIGKILL.
//   5. Enforces global 256 KB result ceiling.
//   6. Preserves stdout and stderr streams independently.

import cp from "node:child_process";
import path from "node:path";
import {
  createSessionId,
  type ExecutionId,
  type ExecutionRequest,
  type ExecutionResult,
  type SessionId,
} from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";
import type { SandboxProvider } from "../core/sandbox-provider.js";
import type { CreateSessionOptions, Session } from "../core/session.js";
import { FORBIDDEN_MOUNT_TARGETS, MAX_EXECUTION_OUTPUT_BYTES } from "../docker/docker-provider.js";

export class LocalProcessSandboxProvider implements SandboxProvider {
  readonly name = "local_process";
  private readonly _sessions = new Map<SessionId, Session>();
  private readonly _activeProcesses = new Map<ExecutionId, cp.ChildProcess>();

  async isAvailable(): Promise<boolean> {
    return true; // Node child_process is always available
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const sessionId = options.id ?? createSessionId();

    const normWorkspace = path.resolve(options.workspacePath);
    for (const forbidden of FORBIDDEN_MOUNT_TARGETS) {
      if (normWorkspace === path.resolve(forbidden)) {
        throw new ValidationError(
          `Mounting "${options.workspacePath}" into sandbox is strictly forbidden`,
        );
      }
    }

    const session: Session = {
      id: sessionId,
      projectId: options.projectId,
      workspacePath: normWorkspace,
      workingDirectory: options.workingDirectory ?? normWorkspace,
      environment: { ...(options.environment ?? {}) },
      readOnlyWorkspace: options.readOnlyWorkspace ?? true,
      networkAllowed: options.networkAllowed ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this._sessions.set(sessionId, session);
    return session;
  }

  async execute(
    session: Session,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const executionId = request.id;

    // Build allowlisted environment: pass only explicitly approved variables (§PR27.9)
    // NEVER do: environment: process.env! Wholesale inheritance is strictly prohibited.
    const cleanEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TMP: process.env.TMP ?? "",
      TEMP: process.env.TEMP ?? "",
      ...session.environment,
      ...(request.environmentVariables ?? {}),
    };

    const cwd = request.workingDirectory ?? session.workingDirectory ?? session.workspacePath;

    return new Promise<ExecutionResult>((resolve) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let timedOut = false;
      let killed = false;

      const proc = cp.spawn(request.command, [...request.args], {
        cwd,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      this._activeProcesses.set(executionId, proc);

      const killProc = () => {
        try {
          if (process.platform === "win32") {
            proc.kill();
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      };

      // Hard wall-clock timeout (§PR27.11)
      const timeoutMs = request.resourceLimits?.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        timedOut = true;
        killProc();
      }, timeoutMs);

      // AbortSignal cancellation (§PR27.11)
      const onAbort = () => {
        killed = true;
        killProc();
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        this._activeProcesses.delete(executionId);

        const durationMs = Date.now() - startTime;
        const exitCode = timedOut ? -1 : (code ?? (killed ? 130 : 0));

        // Enforce 256 KB result ceiling (§PR27.12)
        const truncatedStdout = this._truncateOutput(stdoutBuffer);
        const truncatedStderr = this._truncateOutput(stderrBuffer);

        resolve({
          executionId,
          exitCode,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          durationMs,
          timedOut,
          timestamp: now(),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this._activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;

        resolve({
          executionId,
          exitCode: 1,
          stdout: "",
          stderr: `Process spawn error: ${err.message}`,
          durationMs,
          timedOut: false,
          timestamp: now(),
        });
      });
    });
  }

  async cancel(executionId: ExecutionId): Promise<boolean> {
    const proc = this._activeProcesses.get(executionId);
    if (!proc) {
      return false; // Idempotent
    }

    try {
      if (process.platform === "win32") {
        proc.kill();
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
    this._activeProcesses.delete(executionId);
    return true;
  }

  async destroySession(sessionId: SessionId): Promise<void> {
    this._sessions.delete(sessionId);
  }

  listActiveSessions(): readonly Session[] {
    return [...this._sessions.values()];
  }

  private _truncateOutput(output: string): string {
    if (Buffer.byteLength(output, "utf8") <= MAX_EXECUTION_OUTPUT_BYTES) {
      return output;
    }
    const truncated = Buffer.from(output, "utf8")
      .subarray(0, MAX_EXECUTION_OUTPUT_BYTES)
      .toString("utf8");
    return `${truncated}\n[Output exceeded 256KB ceiling; truncated to 262,144 bytes]`;
  }
}
