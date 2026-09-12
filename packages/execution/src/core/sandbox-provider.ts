// PR27.5: packages/execution — SandboxProvider Contract
//
// Invariants:
//   1. Abstraction layer between ExecutionManager and container/process engines.
//   2. Lifecycle: createSession -> execute -> cancel -> destroySession.
//   3. Supports AbortSignal cooperative cancellation of underlying container/process.
//   4. Decoupled from specific container runtimes (Docker, Podman, Local).

import type {
  ExecutionId,
  ExecutionRequest,
  ExecutionResult,
  SessionId,
} from "@ai-desktop/ai-core";
import type { CreateSessionOptions, Session } from "./session.js";

export interface SandboxProvider {
  readonly name: string;

  /**
   * Checks whether the underlying execution backend is reachable and usable.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Initializes an isolated execution session (allocates container/mounts/env).
   */
  createSession(options: CreateSessionOptions): Promise<Session>;

  /**
   * Executes a command inside the sandbox session.
   * Enforces CPU, memory, PID, network limits, and hard wall-clock timeouts.
   */
  execute(
    session: Session,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>;

  /**
   * Aborts an active execution and terminates the underlying container/process.
   * Safe and idempotent.
   */
  cancel(executionId: ExecutionId): Promise<boolean>;

  /**
   * Destroys an execution session, removing containers and freeing mounts.
   */
  destroySession(sessionId: SessionId): Promise<void>;

  /**
   * Lists active sessions currently managed by this provider.
   */
  listActiveSessions(): readonly Session[];
}
