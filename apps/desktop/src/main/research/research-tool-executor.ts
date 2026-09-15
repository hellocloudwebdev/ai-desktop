// PR35: apps/desktop — Research Tool Executor
//
// Universal lifecycle: resolve -> validate -> permission -> execute.
// Satisfies the ToolExecutorLike contract. Every research tool resolves
// from RESEARCH_TOOL_IDS, validates against its Research*InputSchema before
// any permission check, checks PermissionManager under capability
// "research", then dispatches to ResearchService. Results serialize to
// bounded JSON with provenance; denials and failures return isError: true.

import {
  buildAllResearchToolDefinitions,
  isResearchToolId,
  ResearchDeepInputSchema,
  researchRiskFor,
  ResearchGithubInputSchema,
  ResearchOpenInputSchema,
  ResearchRssInputSchema,
  ResearchSearchInputSchema,
  ResearchYoutubeInputSchema,
  type ResearchActionType,
  type ResearchToolId,
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
import { toCanonicalResearchError } from "./research-errors.js";
import { ResearchOrchestrator } from "./research-orchestrator.js";
import type { ResearchService } from "./research-service.js";

export interface ResearchToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly researchService: ResearchService;
  readonly researchOrchestrator?: ResearchOrchestrator;
}

export interface ExecuteResearchToolOptions {
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
  readonly action: ResearchActionType;
  readonly schema: SchemaValidator;
  readonly getResource: (parsed: Record<string, unknown>) => string;
}

function stringField(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key];
  return typeof value === "string" ? value : "";
}

const TOOL_CONFIGS: Record<ResearchToolId, ToolConfig> = {
  "builtin:research.search": {
    action: "search",
    schema: ResearchSearchInputSchema,
    getResource: (p) => `builtin:research.search::${stringField(p, "query").slice(0, 200)}`,
  },
  "builtin:research.open": {
    action: "open",
    schema: ResearchOpenInputSchema,
    getResource: (p) => `builtin:research.open::${stringField(p, "url").slice(0, 500)}`,
  },
  "builtin:research.github": {
    action: "github",
    schema: ResearchGithubInputSchema,
    getResource: (p) =>
      `builtin:research.github::${(stringField(p, "owner") + "/" + stringField(p, "repo") + " " + stringField(p, "query")).trim().slice(0, 300) || "query"}`,
  },
  "builtin:research.youtube": {
    action: "youtube",
    schema: ResearchYoutubeInputSchema,
    getResource: (p) =>
      `builtin:research.youtube::${(stringField(p, "videoId") || stringField(p, "query")).slice(0, 200) || "query"}`,
  },
  "builtin:research.rss": {
    action: "rss",
    schema: ResearchRssInputSchema,
    getResource: (p) => `builtin:research.rss::${stringField(p, "feedUrl").slice(0, 500)}`,
  },
  "builtin:research.deep": {
    action: "deep",
    schema: ResearchDeepInputSchema,
    getResource: (p) => {
      const queries = Array.isArray(p["queries"]) ? (p["queries"] as unknown[]) : [];
      const first = typeof queries[0] === "string" ? (queries[0] as string) : "deep";
      return `builtin:research.deep::${first.slice(0, 200)} (+${Math.max(0, queries.length - 1)} queries)`;
    },
  },
};

export class ResearchToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _researchService: ResearchService;
  private readonly _orchestrator?: ResearchOrchestrator;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: ResearchToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._researchService = deps.researchService;
    this._orchestrator = deps.researchOrchestrator;
    for (const def of buildAllResearchToolDefinitions()) {
      this._definitions.set(def.name, def);
    }
  }

  private _orchestratorFor(): ResearchOrchestrator {
    return (
      this._orchestrator ?? new ResearchOrchestrator({ researchService: this._researchService })
    );
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
    options?: ExecuteResearchToolOptions,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const toolCallId = options?.toolCallId ?? createToolCallId();

    // 1. Resolve tool definition.
    if (!isResearchToolId(toolName)) {
      throw new ValidationError(`Unknown research tool "${toolName}"`);
    }
    const toolDef = this._definitions.get(toolName);
    const config = TOOL_CONFIGS[toolName];
    if (!toolDef || !config) {
      throw new ValidationError(`Research tool "${toolName}" is not registered`);
    }

    // 2. Validate input BEFORE the permission check.
    const parseResult = config.schema.safeParse(input);
    if (!parseResult.success) {
      throw new ValidationError(
        `Input validation failed for tool "${toolName}": ${parseResult.error.message}`,
        { cause: parseResult.error },
      );
    }
    const validated = parseResult.data as Record<string, unknown>;

    // 3. PermissionManager check (capability "research").
    const convId =
      typeof options?.conversationId === "string"
        ? (options.conversationId as ConversationId)
        : undefined;
    const permResult = await this._permissionManager.check(
      {
        capability: "research",
        action: config.action,
        resource: config.getResource(validated),
        scope: "once",
        risk: researchRiskFor(config.action, false),
        relatedToolCallIds: [toolCallId],
      },
      {
        projectId: options?.projectId,
        conversationId: convId,
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

    // 4. Dispatch to ResearchService.
    const projectId = options?.projectId ?? "default";
    const serviceCtx = {
      projectId,
      toolCallId,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    try {
      let outcome: unknown;
      switch (toolName) {
        case "builtin:research.search":
          outcome = await this._researchService.search(
            String(validated["query"]),
            {
              ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
            },
            serviceCtx,
          );
          break;
        case "builtin:research.open":
          outcome = await this._researchService.open(
            String(validated["url"]),
            {
              ...(typeof validated["maxChars"] === "number"
                ? { maxChars: validated["maxChars"] }
                : {}),
            },
            serviceCtx,
          );
          break;
        case "builtin:research.github":
          outcome = await this._researchService.readGithub(
            {
              ...(typeof validated["query"] === "string" ? { query: validated["query"] } : {}),
              ...(typeof validated["owner"] === "string" ? { owner: validated["owner"] } : {}),
              ...(typeof validated["repo"] === "string" ? { repo: validated["repo"] } : {}),
              ...(typeof validated["path"] === "string" ? { path: validated["path"] } : {}),
              kind:
                (validated["kind"] as "repository" | "file" | "issue" | "search") ?? "repository",
              ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
            },
            serviceCtx,
          );
          break;
        case "builtin:research.youtube":
          outcome = await this._researchService.readYoutube(
            {
              ...(typeof validated["videoId"] === "string"
                ? { videoId: validated["videoId"] }
                : {}),
              ...(typeof validated["query"] === "string" ? { query: validated["query"] } : {}),
              includeTranscript: validated["includeTranscript"] === true,
              ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
            },
            serviceCtx,
          );
          break;
        case "builtin:research.rss":
          outcome = await this._researchService.readRss(
            String(validated["feedUrl"]),
            {
              ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
            },
            serviceCtx,
          );
          break;
        case "builtin:research.deep": {
          const orchestrator = this._orchestratorFor();
          const deepInput = validated as unknown as {
            queries: string[];
            depth: "shallow" | "standard" | "deep";
            freshness: "any" | "day" | "week" | "month" | "year";
            limits?: Record<string, number>;
            requestId?: string;
          };
          outcome = await orchestrator.runDeepResearch(
            {
              queries: deepInput.queries,
              depth: deepInput.depth,
              freshness: deepInput.freshness,
              ...(deepInput.limits ? { limits: deepInput.limits } : {}),
              ...(deepInput.requestId ? { requestId: deepInput.requestId } : {}),
            },
            { ...(options?.signal ? { signal: options.signal } : {}) },
          );
          break;
        }
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
      const canonical = toCanonicalResearchError(err);
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
