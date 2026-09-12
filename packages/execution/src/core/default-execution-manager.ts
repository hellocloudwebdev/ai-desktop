// PR27.6 & PR27.13: packages/execution — Default Execution Manager
//
// Invariants:
//   1. Orchestration layer: validate -> permission check -> session -> sandbox execute.
//   2. Zero Docker code, zero Docker socket, zero child_process in this file.
//   3. Permission integration: checks capability="execution", action="execute", resource=command with cwd.
//   4. Cancels underlying execution cleanly through SandboxProvider.
//   5. Returns canonical ExecutionResult.

import { createToolCallId, now, ValidationError } from "@ai-desktop/shared";
import {
  ExecutionRequestSchema,
  type ExecutionId,
  type ExecutionManager,
  type ExecutionRequest,
  type ExecutionResult,
  type PermissionManager,
  type SessionId,
} from "@ai-desktop/ai-core";
import type { SandboxProvider } from "./sandbox-provider.js";
import type { CreateSessionOptions, Session } from "./session.js";

export interface DefaultExecutionManagerOptions {
  readonly sandboxProvider: SandboxProvider;
  readonly permissionManager?: PermissionManager;
  readonly defaultWorkspacePath?: string;
}

export class DefaultExecutionManager implements ExecutionManager {
  private readonly _sandboxProvider: SandboxProvider;
  private readonly _permissionManager?: PermissionManager;
  private readonly _defaultWorkspacePath: string;
  private readonly _sessions = new Map<SessionId, Session>();
  private readonly _activeExecutions = new Set<ExecutionId>();

  constructor(options: DefaultExecutionManagerOptions) {
    this._sandboxProvider = options.sandboxProvider;
    this._permissionManager = options.permissionManager;
    this._defaultWorkspacePath = options.defaultWorkspacePath ?? process.cwd();
  }

  get sandboxProvider(): SandboxProvider {
    return this._sandboxProvider;
  }

  /**
   * Creates or registers an execution session.
   */
  async createSession(options?: Partial<CreateSessionOptions>): Promise<Session> {
    const session = await this._sandboxProvider.createSession({
      workspacePath: options?.workspacePath ?? this._defaultWorkspacePath,
      projectId: options?.projectId,
      workingDirectory: options?.workingDirectory,
      environment: options?.environment,
      readOnlyWorkspace: options?.readOnlyWorkspace ?? true,
      networkAllowed: options?.networkAllowed ?? false,
    });

    this._sessions.set(session.id, session);
    return session;
  }

  /**
   * Canonical execution entry point implementing ExecutionManager (§PR27.6).
   * Lifecycle: validation -> permission -> session -> sandboxProvider.execute().
   */
  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 1. Strict input validation (§PR27.6)
    const parseResult = ExecutionRequestSchema.safeParse(request);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(`Execution request validation failed: ${issues}`, {
        details: parseResult.error.issues,
      });
    }
    const validRequest = parseResult.data as unknown as ExecutionRequest;

    // 2. Permission check: command- and cwd-aware (§PR27.13)
    if (this._permissionManager) {
      const permResult = await this._permissionManager.check({
        capability: "execution",
        action: "execute",
        resource: validRequest.command,
        scope: "once",
        risk: "medium",
        relatedToolCallIds: [validRequest.relatedToolCallId ?? createToolCallId()],
        metadata: {
          command: validRequest.command,
          args: [...validRequest.args],
          cwd: validRequest.workingDirectory,
        },
      });

      if (permResult.kind !== "allow") {
        const reason =
          permResult.kind === "deny"
            ? (permResult.reason ?? "Denied by permission policy")
            : "Requires user permission confirmation";

        return {
          executionId: validRequest.id,
          exitCode: 126, // Command invoked cannot execute (permission denied)
          stdout: "",
          stderr: `Permission denied: ${reason}`,
          durationMs: Date.now() - startTime,
          timedOut: false,
          timestamp: now(),
          metadata: {
            permissionStatus: permResult.kind,
          },
        };
      }
    }

    // 3. Resolve or allocate execution session
    let session = this._findMatchingSession(validRequest.workingDirectory);
    if (!session) {
      session = await this.createSession({
        workspacePath: validRequest.workingDirectory ?? this._defaultWorkspacePath,
        workingDirectory: validRequest.workingDirectory,
        environment: validRequest.environmentVariables
          ? { ...validRequest.environmentVariables }
          : undefined,
        networkAllowed: validRequest.resourceLimits?.networkAllowed ?? false,
      });
    }

    // 4. Delegate to SandboxProvider (DockerProvider / LocalProcessSandboxProvider)
    this._activeExecutions.add(validRequest.id);

    try {
      const result = await this._sandboxProvider.execute(session, validRequest, signal);
      return result;
    } finally {
      this._activeExecutions.delete(validRequest.id);
    }
  }

  /**
   * Cancels an active execution and terminates the underlying process/container.
   * Safe and idempotent.
   */
  async cancel(executionId: ExecutionId): Promise<boolean> {
    const cancelled = await this._sandboxProvider.cancel(executionId);
    this._activeExecutions.delete(executionId);
    return cancelled;
  }

  /**
   * Destroys an execution session and cleans up resources.
   */
  async destroySession(sessionId: SessionId): Promise<void> {
    await this._sandboxProvider.destroySession(sessionId);
    this._sessions.delete(sessionId);
  }

  private _findMatchingSession(cwd?: string): Session | undefined {
    if (!cwd) return undefined;
    for (const session of this._sessions.values()) {
      if (session.workspacePath === cwd || session.workingDirectory === cwd) {
        return session;
      }
    }
    return undefined;
  }
}
