// PR32: packages/plugins — Plugin Tool Executor
//
// Canonical order: resolve -> validate input -> project/binding check ->
// permission -> handler (with timeout) -> ToolResult.
//
// Invariants:
//   1. Input validation fails BEFORE PermissionManager is invoked.
//   2. Disabled or project-disabled extensions return isError ToolResults with
//      metadata pluginStatus ("disabled" | "project-disabled") WITHOUT calling
//      PermissionManager and WITHOUT invoking any backend handler.
//   3. PermissionManager.check() must allow before the handler runs; non-allow
//      returns an isError ToolResult without backend invocation.
//   4. Handlers are host-owned callbacks in a Map; this executor never spawns
//      processes and never reads process.env wholesale.

import { createToolCallId, now, ValidationError, type ToolCallId } from "@ai-desktop/shared";
import type { PermissionManager, ToolResult } from "@ai-desktop/ai-core";
import type { PluginToolRegistry } from "../tools/extension-tool-contribution.js";
import { parseCanonicalPluginToolId } from "../tools/extension-tool-contribution.js";

export type PluginToolHandler = (input: unknown) => Promise<unknown>;

export interface ExecutePluginToolOptions {
  readonly toolCallId?: ToolCallId;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PluginToolExecutorOptions {
  readonly toolRegistry: PluginToolRegistry;
  readonly permissionManager: PermissionManager;
  readonly handlers: ReadonlyMap<string, PluginToolHandler>;
  readonly isEnabledForProject: (extensionId: string, projectId: string) => boolean;
  readonly isExtensionActive?: (extensionId: string) => boolean;
}

function validateToolInput(parameters: Record<string, unknown>, input: unknown): void {
  if (parameters["type"] === "object" && Array.isArray(parameters["required"])) {
    if (!input || typeof input !== "object") {
      throw new ValidationError(`Tool input must be an object, received ${typeof input}`);
    }
    const inputObj = input as Record<string, unknown>;
    for (const reqField of parameters["required"] as unknown[]) {
      if (typeof reqField === "string" && !(reqField in inputObj)) {
        throw new ValidationError(`Missing required parameter: "${reqField}"`);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Execution aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Plugin tool execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Execution aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class PluginToolExecutor {
  private readonly _registry: PluginToolRegistry;
  private readonly _permissionManager: PermissionManager;
  private readonly _handlers: ReadonlyMap<string, PluginToolHandler>;
  private readonly _isEnabledForProject: (extensionId: string, projectId: string) => boolean;
  private readonly _isExtensionActive?: (extensionId: string) => boolean;

  constructor(options: PluginToolExecutorOptions) {
    this._registry = options.toolRegistry;
    this._permissionManager = options.permissionManager;
    this._handlers = options.handlers;
    this._isEnabledForProject = options.isEnabledForProject;
    this._isExtensionActive = options.isExtensionActive;
  }

  async execute(
    toolName: string,
    input: unknown,
    options?: ExecutePluginToolOptions,
  ): Promise<ToolResult> {
    const toolCallId = options?.toolCallId ?? createToolCallId();
    const startTime = Date.now();

    // 1. Resolve tool definition.
    const toolDef = this._registry.resolve(toolName);
    if (!toolDef) {
      return {
        toolCallId,
        toolName,
        result: `Tool "${toolName}" is not registered or extension is not active`,
        isError: true,
        durationMs: 0,
        timestamp: now(),
      };
    }

    const parsed = parseCanonicalPluginToolId(toolName);
    const extensionId =
      (toolDef.metadata?.["extensionId"] as string | undefined) ?? parsed?.extensionId;

    // 2. Input validation FIRST (before any permission call).
    try {
      validateToolInput(toolDef.parameters, input);
    } catch (validationErr: unknown) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      throw new ValidationError(`Input validation failed for tool "${toolName}": ${msg}`, {
        cause: validationErr,
      });
    }

    // 3. Project/binding check — no permission call, no backend on failure.
    if (extensionId !== undefined) {
      if (this._isExtensionActive && !this._isExtensionActive(extensionId)) {
        return {
          toolCallId,
          toolName,
          result: `Extension "${extensionId}" is disabled`,
          isError: true,
          durationMs: Date.now() - startTime,
          timestamp: now(),
          metadata: { pluginStatus: "disabled" },
        };
      }
      if (
        options?.projectId !== undefined &&
        !this._isEnabledForProject(extensionId, options.projectId)
      ) {
        return {
          toolCallId,
          toolName,
          result: `Extension "${extensionId}" is not enabled for project "${options.projectId}"`,
          isError: true,
          durationMs: Date.now() - startTime,
          timestamp: now(),
          metadata: { pluginStatus: "project-disabled" },
        };
      }
    }

    // 4. Permission check.
    const permResult = await this._permissionManager.check(
      {
        capability: "plugin",
        action: "call",
        resource: toolName,
        scope: "once",
        risk: "medium",
        relatedToolCallIds: [toolCallId],
      },
      {
        projectId: options?.projectId,
        conversationId: options?.conversationId,
      },
    );

    if (permResult.kind !== "allow") {
      const reason =
        permResult.kind === "deny"
          ? (permResult.reason ?? "Denied by permission policy")
          : "Requires user permission confirmation";
      return {
        toolCallId,
        toolName,
        result: `Permission denied: ${reason}`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
        metadata: { permissionStatus: permResult.kind },
      };
    }

    // 5. Handler invocation with timeout. Never spawns processes.
    const handler = this._handlers.get(toolName);
    if (!handler) {
      return {
        toolCallId,
        toolName,
        result: `No handler registered for tool "${toolName}"`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }

    const timeoutMs =
      options?.timeoutMs ?? (toolDef.metadata?.["timeoutMs"] as number | undefined) ?? 30000;

    try {
      const output = await withTimeout(handler(input), timeoutMs, options?.signal);
      return {
        toolCallId,
        toolName,
        result: output,
        isError: false,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    } catch (handlerErr: unknown) {
      return {
        toolCallId,
        toolName,
        result: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
  }
}
