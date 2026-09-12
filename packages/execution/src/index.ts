// PR27: packages/execution — Public API Surface
//
// Invariants:
//   1. Execution engines reside exclusively in packages/execution.
//   2. Sandboxing is separate from permissions.
//   3. Non-root user execution, explicit mounts, allowlisted environment.
//   4. Hard wall-clock timeout and cancellation terminates underlying container/process.

export type { Session, CreateSessionOptions } from "./core/session.js";
export { SessionSchema } from "./core/session.js";

export type { ExecutionRecord, ExecutionStatus } from "./core/execution-context.js";
export { ExecutionStatusSchema } from "./core/execution-context.js";

export type { SandboxProvider } from "./core/sandbox-provider.js";

export type { DefaultExecutionManagerOptions } from "./core/default-execution-manager.js";
export { DefaultExecutionManager } from "./core/default-execution-manager.js";

export type { DockerProviderOptions } from "./docker/docker-provider.js";
export {
  DockerProvider,
  FORBIDDEN_MOUNT_TARGETS,
  MAX_EXECUTION_OUTPUT_BYTES,
} from "./docker/docker-provider.js";

export { LocalProcessSandboxProvider } from "./local/local-sandbox-provider.js";
