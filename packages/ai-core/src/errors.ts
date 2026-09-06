// PR4: packages/ai-core — Domain Error Classes
//
// Domain-specific errors for AI models, tool lifecycles, permission enforcement,
// and event stream integrity, building on BaseError from @ai-desktop/shared.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

export class ModelError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("MODEL_ERROR", message, options);
  }
}

export class ToolExecutionError extends BaseError {
  readonly toolName?: string;

  constructor(toolName: string, message: string, options?: ErrorOptions) {
    super("TOOL_EXECUTION_ERROR", `Tool [${toolName}] failed: ${message}`, options);
    this.toolName = toolName;
  }
}

export class PermissionDeniedError extends BaseError {
  readonly capability?: string;

  constructor(capability: string, message = "Permission denied", options?: ErrorOptions) {
    super("PERMISSION_DENIED", `Capability [${capability}] denied: ${message}`, options);
    this.capability = capability;
  }
}

export class ExecutionSandboxError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("EXECUTION_SANDBOX_ERROR", message, options);
  }
}

export class TaskGraphError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("TASK_GRAPH_ERROR", message, options);
  }
}

export class EventStreamError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super("EVENT_STREAM_ERROR", message, options);
  }
}
