// PR30.5/30.7/30.8: apps/desktop — Coding Builtin Tool Definitions + Executor
//
// Invariants:
//   1. Five canonical builtins: builtin:filesystem.list/search/read/write and
//      builtin:execution.run. Source is always "builtin"; filesystem tools run
//      "in_process", command execution delegates to ExecutionManager ("execution").
//   2. Universal lifecycle per tool call: resolve definition -> validate input ->
//      PermissionManager.check (capability/action/resource from the coding map,
//      real toolCallId) -> backend (filesystem backend or ExecutionManager).
//   3. Filesystem backend is workspace-scoped (path-policy); execution backend
//      never calls Docker directly — only ExecutionManager -> SandboxProvider.
//   4. Definition hashes use the same SHA-256 convention as MCP tool discovery
//      (name/description/parameters/runtime) for trust/invalidation.

import { createHash } from "node:crypto";
import {
  codingCapabilityFor,
  codingRiskFor,
  isCodingToolId,
  type CodingToolId,
} from "@ai-desktop/ai-core";
import { createToolCallId, now, ValidationError, type ToolCallId } from "@ai-desktop/shared";
import { createExecutionId } from "@ai-desktop/ai-core";
import type { ToolDefinition, ToolResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { ExecutionManager } from "@ai-desktop/ai-core";
import {
  isFilesystemError,
  listDirectory,
  readFile,
  searchWorkspace,
  writeFile,
} from "./filesystem/filesystem-tool-backend.js";
import { resolveWorkspacePath } from "./filesystem/path-policy.js";

export function computeCodingToolHash(def: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  runtime: string;
}): string {
  const content = JSON.stringify({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    runtime: def.runtime,
  });
  return createHash("sha256").update(content).digest("hex");
}

function filesystemParameters(tool: CodingToolId): Record<string, unknown> {
  switch (tool) {
    case "builtin:filesystem.list":
      return {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string", description: "Workspace-relative directory path" } },
      };
    case "builtin:filesystem.search":
      return {
        type: "object",
        required: ["path", "query"],
        properties: {
          path: { type: "string", description: "Workspace-relative start path" },
          query: { type: "string", description: "Case-insensitive text/path query" },
        },
      };
    case "builtin:filesystem.read":
      return {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          startLine: { type: "number", description: "First line (1-based)" },
          endLine: { type: "number", description: "Last line (inclusive)" },
        },
      };
    case "builtin:filesystem.write":
      return {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Full replacement file content" },
        },
      };
    case "builtin:execution.run":
      return {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Command to execute" },
          args: { type: "array", description: "Command arguments", items: { type: "string" } },
          cwd: { type: "string", description: "Workspace-relative working directory" },
          timeoutMs: { type: "number", description: "Wall-clock timeout in milliseconds" },
        },
      };
  }
}

function codingToolDescription(tool: CodingToolId): string {
  switch (tool) {
    case "builtin:filesystem.list":
      return "List a workspace directory (workspace-scoped, sorted entries).";
    case "builtin:filesystem.search":
      return "Deterministic recursive workspace search over file names and text (bounded results).";
    case "builtin:filesystem.read":
      return "Read a workspace file with optional line window (bounded bytes/lines).";
    case "builtin:filesystem.write":
      return "Write a workspace file (bounded bytes; creates parent directories).";
    case "builtin:execution.run":
      return "Execute a command through the sandboxed ExecutionManager (permission-gated).";
  }
}

export function buildCodingToolDefinition(tool: CodingToolId): ToolDefinition {
  const runtime = tool === "builtin:execution.run" ? "execution" : "in_process";
  const parameters = filesystemParameters(tool);
  const description = codingToolDescription(tool);
  const definitionHash = computeCodingToolHash({ name: tool, description, parameters, runtime });
  return {
    name: tool,
    description,
    source: "builtin",
    runtime,
    parameters,
    requiredPermissions: [codingCapabilityFor(tool)],
    metadata: { definitionHash },
  };
}

export function buildAllCodingToolDefinitions(): ToolDefinition[] {
  return (
    [
      "builtin:filesystem.list",
      "builtin:filesystem.search",
      "builtin:filesystem.read",
      "builtin:filesystem.write",
      "builtin:execution.run",
    ] as const
  ).map(buildCodingToolDefinition);
}

function validateToolInput(schema: Record<string, unknown>, input: unknown): void {
  const required = (schema as { required?: unknown }).required;
  if (schema.type === "object" && Array.isArray(required)) {
    if (!input || typeof input !== "object") {
      throw new ValidationError(`Tool input must be an object, received ${typeof input}`);
    }
    const inputObj = input as Record<string, unknown>;
    for (const field of required) {
      if (typeof field === "string" && !(field in inputObj)) {
        throw new ValidationError(`Missing required parameter: "${field}"`);
      }
    }
  }
}

export interface CodingToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly executionManager: ExecutionManager;
  readonly resolveWorkspace: (projectId?: string) => string | undefined;
}

export interface ExecuteCodingToolOptions {
  readonly toolCallId?: ToolCallId;
  readonly projectId?: string;
  readonly conversationId?: string;
}

/**
 * Coding builtin executor: resolve -> validate -> permission -> backend.
 * Mirrors McpToolExecutor/SkillToolExecutor lifecycle conventions.
 */
export class CodingToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _executionManager: ExecutionManager;
  private readonly _resolveWorkspace: (projectId?: string) => string | undefined;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: CodingToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._executionManager = deps.executionManager;
    this._resolveWorkspace = deps.resolveWorkspace;
    for (const def of buildAllCodingToolDefinitions()) {
      this._definitions.set(def.name, def);
    }
  }

  hasTool(toolName: string): boolean {
    return this._definitions.has(toolName);
  }

  resolve(toolName: string): ToolDefinition | undefined {
    return this._definitions.get(toolName);
  }

  listTools(): readonly ToolDefinition[] {
    return [...this._definitions.values()];
  }

  async execute(
    toolName: string,
    input: unknown,
    options?: ExecuteCodingToolOptions,
  ): Promise<ToolResult> {
    const toolCallId = options?.toolCallId ?? createToolCallId();
    const startTime = Date.now();
    if (!isCodingToolId(toolName)) {
      throw new ValidationError(`Unknown coding tool "${toolName}"`);
    }
    const toolDef = this._definitions.get(toolName);
    if (!toolDef) {
      throw new ValidationError(`Coding tool "${toolName}" is not registered`);
    }

    // 1. Input validation (malformed input never reaches permission or backend).
    try {
      validateToolInput(toolDef.parameters, input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Input validation failed for tool "${toolName}": ${msg}`, {
        cause: err,
      });
    }
    const args = input as Record<string, unknown>;

    // 2. Permission mediation with the coding capability/resource map.
    const capability = codingCapabilityFor(toolName);
    const resource = codingResourceFor(toolName, args, options?.projectId);
    const permResult = await this._permissionManager.check(
      {
        capability,
        action:
          toolName === "builtin:execution.run"
            ? "execute"
            : resource.startsWith("write:")
              ? "write"
              : "read",
        resource,
        scope: "once",
        risk: codingRiskFor(capability),
        relatedToolCallIds: [toolCallId],
      },
      { projectId: options?.projectId, conversationId: options?.conversationId },
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

    // 3. Workspace resolution (project-bound; never a global filesystem root).
    const workspaceRoot = this._resolveWorkspace(options?.projectId);
    if (!workspaceRoot) {
      return {
        toolCallId,
        toolName,
        result: "No workspace is registered for this project",
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }

    // 4. Backend dispatch.
    try {
      if (toolName === "builtin:execution.run") {
        return await this._executeCommand(
          toolName,
          toolCallId,
          args,
          workspaceRoot,
          options,
          startTime,
        );
      }
      return this._executeFilesystem(toolName, toolCallId, args, workspaceRoot, startTime);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolCallId,
        toolName,
        result: message,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
  }

  private _executeFilesystem(
    toolName: CodingToolId,
    toolCallId: ToolCallId,
    args: Record<string, unknown>,
    workspaceRoot: string,
    startTime: number,
  ): ToolResult {
    const pathArg = String(args.path ?? "");
    let outcome: unknown;
    if (toolName === "builtin:filesystem.list") {
      outcome = listDirectory(workspaceRoot, pathArg);
    } else if (toolName === "builtin:filesystem.read") {
      outcome = readFile(
        workspaceRoot,
        pathArg,
        typeof args.startLine === "number" ? args.startLine : undefined,
        typeof args.endLine === "number" ? args.endLine : undefined,
      );
    } else if (toolName === "builtin:filesystem.write") {
      outcome = writeFile(workspaceRoot, pathArg, String(args.content ?? ""));
    } else {
      outcome = searchWorkspace(workspaceRoot, pathArg, String(args.query ?? ""));
    }
    if (isFilesystemError(outcome)) {
      return {
        toolCallId,
        toolName,
        result: `${outcome.code}: ${outcome.error}`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
    return {
      toolCallId,
      toolName,
      result: JSON.stringify(outcome),
      isError: false,
      durationMs: Date.now() - startTime,
      timestamp: now(),
    };
  }

  private async _executeCommand(
    toolName: string,
    toolCallId: ToolCallId,
    args: Record<string, unknown>,
    workspaceRoot: string,
    options: ExecuteCodingToolOptions | undefined,
    startTime: number,
  ): Promise<ToolResult> {
    const command = String(args.command ?? "");
    const rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    // The cwd is workspace-relative; resolve it through path-policy so the
    // sandbox never spawns outside the workspace (traversal rejected here).
    const cwdRequested = typeof args.cwd === "string" && args.cwd ? args.cwd : ".";
    let workingDirectory: string;
    try {
      workingDirectory = resolveWorkspacePath(workspaceRoot, cwdRequested).targetReal;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolCallId,
        toolName,
        result: `Invalid working directory: ${message}`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? Math.min(Math.floor(args.timeoutMs), 120000)
        : 30000;
    const result = await this._executionManager.execute(
      {
        id: createExecutionId(),
        relatedToolCallId: toolCallId,
        mode: "sandboxed",
        command,
        args: rawArgs,
        workingDirectory,
        resourceLimits: { timeoutMs, networkAllowed: false },
        timestamp: now(),
        metadata: { workspaceRoot, projectId: options?.projectId },
      },
      undefined,
    );
    return {
      toolCallId,
      toolName,
      result: JSON.stringify({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      }),
      isError: result.exitCode !== 0,
      durationMs: Date.now() - startTime,
      timestamp: now(),
    };
  }
}

/** Resource string carrying path/command context into permission evaluation. */
export function codingResourceFor(
  toolName: CodingToolId,
  args: Record<string, unknown>,
  projectId?: string,
): string {
  const scope = projectId ?? "global";
  if (toolName === "builtin:execution.run") {
    const command = String(args.command ?? "");
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : ".";
    return `${scope}::exec:${command}::cwd:${cwd}`;
  }
  const pathArg = String(args.path ?? "");
  const prefix = toolName === "builtin:filesystem.write" ? "write" : "read";
  return `${scope}::${prefix}:${pathArg}`;
}
