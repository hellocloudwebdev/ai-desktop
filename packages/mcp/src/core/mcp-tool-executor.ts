// PR25.9 & PR25.10: packages/mcp — MCP Tool Executor & Lifecycle
//
// Invariants:
//   1. Strict universal lifecycle: validation -> permission -> execution.
//   2. Validation failure aborts before PermissionManager is called.
//   3. PermissionManager.check() must pass ("allow") before execution.
//   4. Supports timeouts: soft warning + hard timeout terminating execution via AbortController.
//   5. Global 256 KB result ceiling applied at the executor boundary.
//   6. Returns canonical ToolResult (never raw MCP CallToolResult).

import { createToolCallId, now, ValidationError, type ToolCallId } from "@ai-desktop/shared";
import type { ToolResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { MCPHost } from "./mcp-host.js";
import { parseCanonicalToolId } from "./tool-converter.js";
import type { ToolRegistry } from "./tool-registry.js";

export const MAX_RESULT_BYTES = 256 * 1024; // 256 KB limit

export interface ExecuteMcpToolOptions {
  readonly toolCallId?: ToolCallId;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly softTimeoutMs?: number; // default 15000ms
  readonly hardTimeoutMs?: number; // default 30000ms
  readonly signal?: AbortSignal;
}

export interface McpToolExecutorEvents {
  onSoftTimeout?: (toolName: string, durationMs: number) => void;
}

/**
 * Validates input arguments against the tool parameters schema.
 */
function validateToolInput(schema: Record<string, unknown>, input: unknown): void {
  if (schema.type === "object" && schema.required && Array.isArray(schema.required)) {
    if (!input || typeof input !== "object") {
      throw new ValidationError(`Tool input must be an object, received ${typeof input}`);
    }
    const inputObj = input as Record<string, unknown>;
    for (const reqField of schema.required) {
      if (typeof reqField === "string" && !(reqField in inputObj)) {
        throw new ValidationError(`Missing required parameter: "${reqField}"`);
      }
    }
  }
}

export class McpToolExecutor {
  private readonly _registry: ToolRegistry;
  private readonly _permissionManager: PermissionManager;
  private readonly _mcpHost: MCPHost;
  private readonly _events?: McpToolExecutorEvents;

  constructor(
    registry: ToolRegistry,
    permissionManager: PermissionManager,
    mcpHost: MCPHost,
    events?: McpToolExecutorEvents,
  ) {
    this._registry = registry;
    this._permissionManager = permissionManager;
    this._mcpHost = mcpHost;
    this._events = events;
  }

  /**
   * Executes an MCP tool through the canonical lifecycle:
   *   1. Resolve tool definition from registry
   *   2. Validate input schema
   *   3. Check PermissionManager
   *   4. Execute via MCPHost with timeout and cancellation
   *   5. Enforce 256 KB result ceiling
   */
  async execute(
    toolName: string,
    input: unknown,
    options?: ExecuteMcpToolOptions,
  ): Promise<ToolResult> {
    const toolCallId = options?.toolCallId ?? createToolCallId();
    const startTime = Date.now();

    // 1. Resolve tool definition (§PR24.8)
    const toolDef = this._registry.resolve(toolName);
    if (!toolDef) {
      return {
        toolCallId,
        toolName,
        result: `Tool "${toolName}" is not registered or unavailable`,
        isError: true,
        durationMs: 0,
        timestamp: now(),
      };
    }

    // 2. Input validation FIRST (§PR24.8)
    // Fails before permission check if input is invalid!
    try {
      validateToolInput(toolDef.parameters, input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Input validation failed for tool "${toolName}": ${msg}`, {
        cause: err,
      });
    }

    // 3. Permission check SECOND (§PR24.8, §PR25.9)
    // Tool execution must be mediated through PermissionManager.check()
    const permResult = await this._permissionManager.check(
      {
        capability: "mcp",
        action: "call",
        resource: toolName,
        scope: "once",
        risk: "low",
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
        metadata: {
          permissionStatus: permResult.kind,
        },
      };
    }

    // 4. Execution THIRD (§PR24.8, §PR25.10)
    // Setup abort controller and timeout handling
    const parsed = parseCanonicalToolId(toolName);
    if (!parsed) {
      return {
        toolCallId,
        toolName,
        result: `Invalid canonical MCP tool name: "${toolName}"`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }

    const { serverId, toolName: rawName } = parsed;
    const controller = new AbortController();

    // If caller provided an AbortSignal, link it
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => controller.abort(options.signal!.reason), {
          once: true,
        });
      }
    }

    // Soft & hard timeouts
    const softTimeoutMs = options?.softTimeoutMs ?? 15000;
    const hardTimeoutMs = options?.hardTimeoutMs ?? 30000;

    const softTimer = setTimeout(() => {
      this._events?.onSoftTimeout?.(toolName, Date.now() - startTime);
    }, softTimeoutMs);

    const hardTimer = setTimeout(() => {
      controller.abort("Operation timed out");
    }, hardTimeoutMs);

    try {
      const mcpResult = await this._mcpHost.callTool(serverId, rawName, input, controller.signal);

      clearTimeout(softTimer);
      clearTimeout(hardTimer);

      const durationMs = Date.now() - startTime;

      // Check if execution was aborted during call
      if (controller.signal.aborted) {
        return {
          toolCallId,
          toolName,
          result: "Tool execution was cancelled",
          isError: true,
          durationMs,
          timestamp: now(),
          metadata: {
            cancelled: true,
            error: controller.signal.reason ? String(controller.signal.reason) : "Cancelled",
          },
        };
      }

      // 5. Enforce global 256 KB result ceiling (§PR25.10)
      const serialized =
        typeof mcpResult.result === "string" ? mcpResult.result : JSON.stringify(mcpResult.result);

      const resultBytes = Buffer.byteLength(serialized, "utf8");
      if (resultBytes > MAX_RESULT_BYTES) {
        // Truncate to ceiling with warning
        const truncated = Buffer.from(serialized, "utf8")
          .subarray(0, MAX_RESULT_BYTES)
          .toString("utf8");
        return {
          toolCallId,
          toolName,
          result: `${truncated}\n[Result exceeded 256KB ceiling; truncated to 262,144 bytes]`,
          isError: mcpResult.isError,
          durationMs,
          timestamp: now(),
          metadata: {
            ...mcpResult.metadata,
            truncated: true,
            originalBytes: resultBytes,
          },
        };
      }

      return {
        ...mcpResult,
        toolCallId,
        durationMs,
      };
    } catch (err: unknown) {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      const durationMs = Date.now() - startTime;
      const isCancelled = controller.signal.aborted;
      const errMsg = err instanceof Error ? err.message : String(err);

      return {
        toolCallId,
        toolName,
        result: isCancelled ? "Tool execution was cancelled" : `Tool execution failed: ${errMsg}`,
        isError: true,
        durationMs,
        timestamp: now(),
        metadata: {
          cancelled: isCancelled,
          error: errMsg,
        },
      };
    }
  }
}
