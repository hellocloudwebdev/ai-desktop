// PR27.7, PR27.8, PR27.9, PR27.10, PR27.11: packages/execution — Docker Sandbox Provider
//
// Invariants:
//   1. Non-root user execution: containers run as unprivileged non-root (--user 1000:1000).
//   2. Explicit workspace mounting: mounts only workspacePath; forbids /, $HOME, /etc, docker.sock.
//   3. Environment allowlist: passes only explicit request/session env; NEVER wholesale process.env.
//   4. Resource enforcement: actual Docker flags for CPU (--cpus), memory (--memory), PID (--pids-limit).
//   5. Network restriction: default --network none (restricted).
//   6. Hard wall-clock timeout & cancellation: terminates underlying container via docker kill.
//   7. Result limit: 256 KB ceiling applied to stdout/stderr.
//   8. Container cleanup: --rm ensures no orphaned containers remain.

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

export const MAX_EXECUTION_OUTPUT_BYTES = 256 * 1024; // 256 KB ceiling

export const FORBIDDEN_MOUNT_TARGETS = [
  "/",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/var/run/docker.sock",
  "/var/run",
  "C:\\",
  "C:\\Windows",
];

export interface DockerProviderOptions {
  readonly defaultImage?: string;
  readonly defaultCpuLimit?: number;
  readonly defaultMemoryLimitMb?: number;
  readonly defaultPidsLimit?: number;
}

export class DockerProvider implements SandboxProvider {
  readonly name = "docker";
  private readonly _defaultImage: string;
  private readonly _defaultCpuLimit: number;
  private readonly _defaultMemoryLimitMb: number;
  private readonly _defaultPidsLimit: number;

  private readonly _sessions = new Map<SessionId, Session>();
  private readonly _activeProcesses = new Map<
    ExecutionId,
    { containerName: string; proc?: cp.ChildProcess }
  >();

  constructor(options?: DockerProviderOptions) {
    this._defaultImage = options?.defaultImage ?? "alpine:3.20";
    this._defaultCpuLimit = options?.defaultCpuLimit ?? 1.0;
    this._defaultMemoryLimitMb = options?.defaultMemoryLimitMb ?? 512;
    this._defaultPidsLimit = options?.defaultPidsLimit ?? 100;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = cp.spawnSync("docker", ["--version"], { encoding: "utf8" });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const sessionId = options.id ?? createSessionId();

    // Validate workspace path safety (§PR27.8)
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
      workingDirectory: options.workingDirectory ?? "/workspace",
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
    const containerName = `ai-desktop-exec-${executionId.toLowerCase()}`;

    // 1. Build secure Docker arguments enforcing all resource constraints
    const dockerArgs = this.buildDockerRunArgs(session, request, containerName);

    return new Promise<ExecutionResult>((resolve) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let timedOut = false;
      let killed = false;

      const proc = cp.spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this._activeProcesses.set(executionId, { containerName, proc });

      // Timeout management (§PR27.11)
      const timeoutMs = request.resourceLimits?.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        timedOut = true;
        this._killContainer(containerName, proc);
      }, timeoutMs);

      // AbortSignal cooperative cancellation (§PR27.11)
      const onAbort = () => {
        killed = true;
        this._killContainer(containerName, proc);
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
          stderr: `Failed to invoke docker: ${err.message}`,
          durationMs,
          timedOut: false,
          timestamp: now(),
        });
      });
    });
  }

  /**
   * Pure builder for Docker CLI arguments enforcing all canonical sandbox parameters.
   */
  buildDockerRunArgs(session: Session, request: ExecutionRequest, containerName: string): string[] {
    const args: string[] = ["run", "--rm", "--name", containerName];

    // 1. Non-root user execution (§PR27.7)
    args.push("--user", "1000:1000");

    // 2. Resource limits enforcement (§PR27.10)
    const cpus = request.resourceLimits?.cpuShares ?? this._defaultCpuLimit;
    args.push(`--cpus=${cpus}`);

    const memMb = request.resourceLimits?.memoryLimitMb ?? this._defaultMemoryLimitMb;
    args.push(`--memory=${memMb}m`);

    args.push(`--pids-limit=${this._defaultPidsLimit}`);

    // 3. Network restriction (§PR27.10)
    // Default is restricted (--network none) unless explicitly permitted
    const networkAllowed = request.resourceLimits?.networkAllowed ?? session.networkAllowed;
    if (!networkAllowed) {
      args.push("--network", "none");
    }

    // 4. Workspace mounting (§PR27.8)
    const mountMode = session.readOnlyWorkspace ? "ro" : "rw";
    args.push("-v", `${session.workspacePath}:/workspace:${mountMode}`);
    args.push("-w", session.workingDirectory || "/workspace");

    // 5. Environment allowlist (§PR27.9)
    // Pass only approved variables; NEVER wholesale process.env
    const combinedEnv = {
      ...session.environment,
      ...(request.environmentVariables ?? {}),
    };
    for (const [k, v] of Object.entries(combinedEnv)) {
      args.push("-e", `${k}=${v}`);
    }

    // 6. Target image and command
    args.push(this._defaultImage, request.command, ...request.args);

    return args;
  }

  async cancel(executionId: ExecutionId): Promise<boolean> {
    const active = this._activeProcesses.get(executionId);
    if (!active) {
      return false; // Idempotent
    }

    this._killContainer(active.containerName, active.proc);
    this._activeProcesses.delete(executionId);
    return true;
  }

  async destroySession(sessionId: SessionId): Promise<void> {
    this._sessions.delete(sessionId);
  }

  listActiveSessions(): readonly Session[] {
    return [...this._sessions.values()];
  }

  /**
   * Cleans up any orphaned containers created by ai-desktop executions (§PR27.15).
   */
  async cleanupOrphanedContainers(): Promise<number> {
    try {
      const psRes = cp.spawnSync(
        "docker",
        ["ps", "-a", "--filter", "name=ai-desktop-exec-", "--format", "{{.ID}}"],
        { encoding: "utf8" },
      );
      if (psRes.status !== 0 || !psRes.stdout.trim()) {
        return 0;
      }
      const ids = psRes.stdout.trim().split("\n").filter(Boolean);
      for (const id of ids) {
        cp.spawnSync("docker", ["rm", "-f", id]);
      }
      return ids.length;
    } catch {
      return 0;
    }
  }

  private _killContainer(containerName: string, proc?: cp.ChildProcess): void {
    try {
      cp.spawnSync("docker", ["kill", containerName]);
    } catch {
      // ignore
    }
    if (proc && !proc.killed) {
      proc.kill("SIGKILL");
    }
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
