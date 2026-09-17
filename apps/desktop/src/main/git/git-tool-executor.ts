// PR42: apps/desktop — Git Tool Executor
//
// Universal lifecycle: resolve -> validate -> permission -> execute.
// Satisfies the ToolExecutorLike contract for canonical Git tools:
//   - builtin:git.status
//   - builtin:git.diff
//   - builtin:git.log
//   - builtin:git.branches
//   - builtin:git.stage
//   - builtin:git.unstage
//   - builtin:git.commit
//
// Every operation validates Zod schema before permission check, enforces
// capability "git" via PermissionManager, and dispatches to GitService.
// Results serialize to bounded JSON; denials and errors return isError: true.

import {
  buildAllGitToolDefinitions,
  gitRiskFor,
  isGitToolId,
  GitBranchesInputSchema,
  GitCommitInputSchema,
  GitDiffInputSchema,
  GitLogInputSchema,
  GitStageInputSchema,
  GitStatusInputSchema,
  GitUnstageInputSchema,
  type GitActionType,
  type GitToolId,
  type ToolDefinition,
  type ToolResult,
} from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import {
  createToolCallId,
  now,
  ValidationError,
  type ConversationId,
  type ToolCallId,
} from "@ai-desktop/shared";
import { toCanonicalGitError } from "./git-errors.js";
import type { GitService } from "./git-service.js";

export interface GitToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly gitService: GitService;
}

export interface ExecuteGitToolOptions {
  readonly toolCallId?: ToolCallId;
  readonly projectId?: string;
  readonly conversationId?: ConversationId | unknown;
  readonly signal?: AbortSignal;
}

interface SchemaValidator {
  safeParse(
    val: unknown,
  ): { success: true; data: unknown } | { success: false; error: { message: string } };
}

interface ToolConfig {
  readonly action: GitActionType;
  readonly schema: SchemaValidator;
}

const TOOL_CONFIGS: Record<GitToolId, ToolConfig> = {
  "builtin:git.status": {
    action: "status",
    schema: GitStatusInputSchema,
  },
  "builtin:git.diff": {
    action: "diff",
    schema: GitDiffInputSchema,
  },
  "builtin:git.log": {
    action: "log",
    schema: GitLogInputSchema,
  },
  "builtin:git.branches": {
    action: "branches",
    schema: GitBranchesInputSchema,
  },
  "builtin:git.stage": {
    action: "stage",
    schema: GitStageInputSchema,
  },
  "builtin:git.unstage": {
    action: "unstage",
    schema: GitUnstageInputSchema,
  },
  "builtin:git.commit": {
    action: "commit",
    schema: GitCommitInputSchema,
  },
};

export class GitToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _gitService: GitService;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: GitToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._gitService = deps.gitService;
    for (const def of buildAllGitToolDefinitions()) {
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
    options?: ExecuteGitToolOptions,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const toolCallId = options?.toolCallId ?? createToolCallId();

    // 1. Resolve tool definition
    if (!isGitToolId(toolName)) {
      throw new ValidationError(`Unknown git tool "${toolName}"`);
    }
    const toolDef = this._definitions.get(toolName);
    const config = TOOL_CONFIGS[toolName];
    if (!toolDef || !config) {
      throw new ValidationError(`Git tool "${toolName}" is not registered`);
    }

    // 2. Validate input BEFORE permission check
    const parseResult = config.schema.safeParse(input);
    if (!parseResult.success) {
      throw new ValidationError(
        `Input validation failed for tool "${toolName}": ${parseResult.error.message}`,
        { cause: parseResult.error },
      );
    }
    const validated = parseResult.data as Record<string, unknown>;

    // 3. PermissionManager check (capability "git")
    const projectId = (validated["projectId"] as string) || options?.projectId || "default";
    const resource = `git::${projectId}::${config.action}`;
    const convId =
      typeof options?.conversationId === "string"
        ? (options.conversationId as ConversationId)
        : undefined;

    const permResult = await this._permissionManager.check(
      {
        capability: "git",
        action: config.action,
        resource,
        scope: "once",
        risk: gitRiskFor(config.action),
        relatedToolCallIds: [toolCallId],
      },
      {
        projectId,
        ...(convId ? { conversationId: convId } : {}),
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

    // 4. Dispatch to GitService
    try {
      let outcome: unknown;
      switch (toolName) {
        case "builtin:git.status":
          outcome = await this._gitService.getStatus(projectId, options?.signal);
          break;
        case "builtin:git.diff":
          outcome = await this._gitService.getDiff(projectId, {
            staged: validated["staged"] === true,
            ...(typeof validated["path"] === "string" ? { path: validated["path"] } : {}),
            signal: options?.signal,
          });
          break;
        case "builtin:git.log":
          outcome = await this._gitService.getLog(projectId, {
            ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
            signal: options?.signal,
          });
          break;
        case "builtin:git.branches":
          outcome = await this._gitService.getBranches(projectId, options?.signal);
          break;
        case "builtin:git.stage":
          outcome = await this._gitService.stage(
            projectId,
            validated["paths"] as string[],
            options?.signal,
          );
          break;
        case "builtin:git.unstage":
          outcome = await this._gitService.unstage(
            projectId,
            validated["paths"] as string[],
            options?.signal,
          );
          break;
        case "builtin:git.commit":
          outcome = await this._gitService.commit(
            projectId,
            String(validated["message"]),
            options?.signal,
          );
          break;
      }

      return {
        toolCallId,
        toolName,
        result: typeof outcome === "string" ? outcome : JSON.stringify(outcome),
        isError: false,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    } catch (err: unknown) {
      const canonical = toCanonicalGitError(err);
      return {
        toolCallId,
        toolName,
        result: `[${canonical.code}] ${canonical.message}`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
  }
}
