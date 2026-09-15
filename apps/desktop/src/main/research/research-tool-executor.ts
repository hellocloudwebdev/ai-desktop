// PR35.12/35.24: apps/desktop — Research Tool Executor
//
// Invariants:
//   1. Universal lifecycle: resolve definition -> Zod validate input BEFORE
//      permission -> PermissionManager.check (capability "research",
//      scope "once", mapped action/risk, real toolCallId) -> ResearchService.
//   2. Search executions stamp an additive metadata.surface table descriptor
//      (PR33 convention via buildSurfaceMetadata); the SurfaceService
//      independently enforces binding hash-match, so the stamp alone creates
//      nothing. Other tools stamp nothing.
//   3. AbortSignal flows end to end (options.signal -> service -> adapters).
//      Permission denial returns isError ToolResult, never throws.
//   4. ToolResult payloads respect the 256 KB ceiling (service enforces;
//      executor re-checks defensively).

import {
  buildAllResearchToolDefinitions,
  buildSurfaceMetadata,
  isResearchToolId,
  RESEARCH_CAPABILITY,
  ResearchGithubInputSchema,
  ResearchOpenInputSchema,
  ResearchRssInputSchema,
  ResearchSearchInputSchema,
  ResearchYoutubeInputSchema,
  researchRiskFor,
  MAX_RESEARCH_TOOL_RESULT_BYTES,
  type ResearchAction,
  type ResearchResult,
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
import type { ResearchService } from "./research-service.js";

export interface ResearchToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly researchService: ResearchService;
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

const TOOL_SCHEMAS: Record<ResearchToolId, { action: ResearchAction; schema: SchemaValidator }> = {
  "builtin:research.search": { action: "search", schema: ResearchSearchInputSchema },
  "builtin:research.open": { action: "open", schema: ResearchOpenInputSchema },
  "builtin:research.github": { action: "github", schema: ResearchGithubInputSchema },
  "builtin:research.youtube": { action: "youtube", schema: ResearchYoutubeInputSchema },
  "builtin:research.rss": { action: "rss", schema: ResearchRssInputSchema },
};

export class ResearchToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _researchService: ResearchService;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: ResearchToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._researchService = deps.researchService;
    for (const def of buildAllResearchToolDefinitions()) {
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
    options?: ExecuteResearchToolOptions,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const toolCallId = options?.toolCallId ?? createToolCallId();

    if (!isResearchToolId(toolName)) {
      throw new ValidationError(`Unknown research tool "${toolName}"`);
    }
    const toolDef = this._definitions.get(toolName);
    const config = TOOL_SCHEMAS[toolName];
    if (!toolDef || !config) {
      throw new ValidationError(`Research tool "${toolName}" is not registered`);
    }

    const parseResult = config.schema.safeParse(input);
    if (!parseResult.success) {
      throw new ValidationError(
        `Input validation failed for tool "${toolName}": ${parseResult.error.message}`,
        { cause: parseResult.error },
      );
    }
    const validated = parseResult.data as Record<string, unknown>;

    const resource = `${toolName}::${resourceTarget(config.action, validated)}`;
    const convId =
      typeof options?.conversationId === "string"
        ? (options.conversationId as ConversationId)
        : undefined;
    const permResult = await this._permissionManager.check(
      {
        capability: RESEARCH_CAPABILITY,
        action: config.action,
        resource,
        scope: "once",
        risk: researchRiskFor(config.action, isAuthenticatedInput(config.action, validated)),
        relatedToolCallIds: [toolCallId],
      },
      {
        ...(options?.projectId ? { projectId: options.projectId } : {}),
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

    try {
      const outcome = await this._dispatch(
        config.action,
        validated,
        toolCallId,
        options?.signal,
        options?.projectId,
      );
      const payload = JSON.stringify(outcome);
      if (Buffer.byteLength(payload, "utf8") > MAX_RESEARCH_TOOL_RESULT_BYTES) {
        return {
          toolCallId,
          toolName,
          result: `[RESPONSE_TOO_LARGE] Research result exceeded size ceiling`,
          isError: true,
          durationMs: Date.now() - startTime,
          timestamp: now(),
        };
      }
      return {
        toolCallId,
        toolName,
        result: payload,
        isError: false,
        durationMs: Date.now() - startTime,
        timestamp: now(),
        ...(toolName === "builtin:research.search"
          ? { metadata: searchSurfaceMetadata(outcome) }
          : {}),
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

  private async _dispatch(
    action: ResearchAction,
    input: Record<string, unknown>,
    toolCallId: ToolCallId,
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<ResearchResult> {
    const callOptions = {
      ...(signal ? { signal } : {}),
      ...(projectId ? { projectId } : {}),
    };
    switch (action) {
      case "search":
        return this._researchService.searchWeb(String(input.query ?? ""), {
          ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
          ...callOptions,
        });
      case "open":
        return this._researchService.openWebPage(String(input.url ?? ""), {
          ...(typeof input.maxChars === "number" ? { maxChars: input.maxChars } : {}),
          ...callOptions,
        });
      case "github":
        return this._researchService.readGithub(
          {
            operation: input.operation as "repository" | "file" | "issue" | "pull" | "search",
            ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
            ...(typeof input.repo === "string" ? { repo: input.repo } : {}),
            ...(typeof input.path === "string" ? { path: input.path } : {}),
            ...(typeof input.ref === "string" ? { ref: input.ref } : {}),
            ...(typeof input.number === "number" ? { number: input.number } : {}),
            ...(typeof input.query === "string" ? { query: input.query } : {}),
            ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
          },
          callOptions,
        );
      case "youtube":
        return this._researchService.readYoutube(
          {
            operation: input.operation as "metadata" | "transcript" | "search",
            ...(typeof input.videoId === "string" ? { videoId: input.videoId } : {}),
            ...(typeof input.url === "string" ? { url: input.url } : {}),
            ...(typeof input.query === "string" ? { query: input.query } : {}),
            ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
          },
          callOptions,
        );
      case "rss":
        return this._researchService.readRssFeed(String(input.url ?? ""), {
          ...(typeof input.maxItems === "number" ? { maxItems: input.maxItems } : {}),
          ...callOptions,
        });
    }
    void toolCallId;
  }
}

function resourceTarget(action: ResearchAction, input: Record<string, unknown>): string {
  switch (action) {
    case "search":
      return String(input.query ?? "");
    case "open":
    case "rss":
      return String(input.url ?? "");
    case "github":
      return `${String(input.owner ?? "")}/${String(input.repo ?? "")}:${String(input.operation ?? "")}`;
    case "youtube":
      return String(input.videoId ?? input.url ?? input.query ?? input.operation ?? "");
  }
}

/** Authenticated reads (key-backed adapters) carry medium risk downstream. */
function isAuthenticatedInput(action: ResearchAction, input: Record<string, unknown>): boolean {
  void input;
  // Auth state is adapter-owned (SecretRef present); the permission layer
  // classifies public reads low. Adapter-keyed operations (github/youtube
  // search with configured keys) elevate at the service provenance layer.
  // Executor conservatively marks github/youtube medium-risk: these channels
  // may resolve credentials host-side.
  return action === "github" || action === "youtube";
}

/** Additive PR33 table stamp for search results (never throws). */
function searchSurfaceMetadata(outcome: ResearchResult): Record<string, unknown> {
  try {
    const results = (outcome.metadata as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results) || results.length === 0) return {};
    // Stamp-only signal: the descriptor declares a table surface; row data
    // stays in the ToolResult body and host caps apply at materialization.
    // SurfaceService hash-match still governs creation (no forged surfaces).
    return buildSurfaceMetadata({
      id: "research-search-results" as never,
      version: "1.0.0",
      kind: "table",
      title: outcome.title ?? "Research results",
      dataSchema: {},
    }) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}
