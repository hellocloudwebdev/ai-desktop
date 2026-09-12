// PR26.11, PR26.12, PR26.13: packages/skills — Skill Tool Executor & Pre-Execution Integrity Verification
//
// Invariants:
//   1. Canonical order: validation -> permission -> execution.
//   2. Input validation fails before PermissionManager is invoked.
//   3. PermissionManager.check() must allow before execution.
//   4. CHECKSUM VERIFICATION: Immediately before execution, script file checksum
//      is computed and compared against approved checksum. Mismatch blocks execution!
//   5. Execution delegates exclusively to ExecutionManager (zero process spawning in skills).
//   6. Execution context: only explicit inputs and approved env; never wholesale process.env.
//   7. Returns canonical ToolResult.

import fs from "node:fs";
import { createToolCallId, now, ValidationError, type ToolCallId } from "@ai-desktop/shared";
import {
  createExecutionId,
  type ExecutionManager,
  type ExecutionRequest,
  type PermissionManager,
  type ToolResult,
} from "@ai-desktop/ai-core";
import { computeFileChecksum } from "./skill-validator.js";
import type { SkillToolRegistry } from "./tool-registry.js";

export interface ExecuteSkillToolOptions {
  readonly toolCallId?: ToolCallId;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly timeoutMs?: number;
  readonly approvedEnv?: Record<string, string>;
  readonly signal?: AbortSignal;
}

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

export class SkillToolExecutor {
  private readonly _registry: SkillToolRegistry;
  private readonly _permissionManager: PermissionManager;
  private readonly _executionManager: ExecutionManager;

  constructor(
    registry: SkillToolRegistry,
    permissionManager: PermissionManager,
    executionManager: ExecutionManager,
  ) {
    this._registry = registry;
    this._permissionManager = permissionManager;
    this._executionManager = executionManager;
  }

  /**
   * Executes a Skill script through the canonical lifecycle:
   *   1. Resolve tool definition from registry
   *   2. Validate input schema
   *   3. Check PermissionManager
   *   4. Verify script checksum on disk IMMEDIATELY before execution (§PR26.13)
   *   5. Execute via ExecutionManager (sandboxed/isolated)
   */
  async execute(
    toolName: string,
    input: unknown,
    options?: ExecuteSkillToolOptions,
  ): Promise<ToolResult> {
    const toolCallId = options?.toolCallId ?? createToolCallId();
    const startTime = Date.now();

    // 1. Resolve tool definition (§PR26.9)
    const toolDef = this._registry.resolve(toolName);
    if (!toolDef) {
      return {
        toolCallId,
        toolName,
        result: `Tool "${toolName}" is not registered or skill is not active`,
        isError: true,
        durationMs: 0,
        timestamp: now(),
      };
    }

    // 2. Input validation FIRST (§PR26.11)
    try {
      validateToolInput(toolDef.parameters, input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Input validation failed for tool "${toolName}": ${msg}`, {
        cause: err,
      });
    }

    // 3. Permission check SECOND (§PR26.11)
    const permResult = await this._permissionManager.check(
      {
        capability: "execution",
        action: "execute",
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
        metadata: {
          permissionStatus: permResult.kind,
        },
      };
    }

    // 4. Pre-execution Checksum Verification IMMEDIATELY BEFORE EXECUTION (§PR26.13)
    const scriptPath = toolDef.metadata?.scriptPath as string | undefined;
    const approvedChecksum = toolDef.metadata?.approvedChecksum as string | undefined;

    if (!scriptPath || !approvedChecksum || !fs.existsSync(scriptPath)) {
      throw new ValidationError(`Script file not found for tool "${toolName}": "${scriptPath}"`);
    }

    const actualChecksum = computeFileChecksum(scriptPath);
    if (actualChecksum.toLowerCase() !== approvedChecksum.toLowerCase()) {
      // SCRIPT CONTENT WAS MODIFIED! Block execution immediately!
      throw new ValidationError(
        `Integrity check failed: script checksum mismatch for "${toolName}". Expected "${approvedChecksum}", found "${actualChecksum}". Re-approval required.`,
      );
    }

    // 5. Build ExecutionRequest and delegate to ExecutionManager (§PR26.12)
    const command = (toolDef.metadata?.command as string) ?? "node";
    const installPath = toolDef.metadata?.installPath as string | undefined;
    const timeoutMs =
      options?.timeoutMs ?? (toolDef.metadata?.timeoutMs as number | undefined) ?? 30000;

    const execRequest: ExecutionRequest = {
      id: createExecutionId(),
      relatedToolCallId: toolCallId,
      mode: "sandboxed",
      command,
      args: [scriptPath, JSON.stringify(input ?? {})],
      workingDirectory: installPath,
      // Isolation invariant: pass only approved environment; never wholesale process.env (§PR26.12)
      environmentVariables: options?.approvedEnv ?? {},
      resourceLimits: {
        timeoutMs,
        networkAllowed: false,
      },
      timestamp: now(),
      metadata: {
        toolName,
        skillId: toolDef.metadata?.skillId,
      },
    };

    const execResult = await this._executionManager.execute(execRequest, options?.signal);
    const durationMs = Date.now() - startTime;

    return {
      toolCallId,
      toolName,
      result:
        execResult.exitCode === 0 ? execResult.stdout : execResult.stderr || execResult.stdout,
      isError: execResult.exitCode !== 0,
      durationMs,
      timestamp: now(),
      metadata: {
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
      },
    };
  }
}
