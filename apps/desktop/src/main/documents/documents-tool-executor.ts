// PR37: apps/desktop — Documents Tool Executor
//
// Universal lifecycle: resolve -> validate -> permission -> execute.
// Satisfies the ToolExecutorLike contract. Every documents tool resolves
// from DOCUMENT_TOOL_IDS, validates against its Documents*InputSchema before
// any permission check, checks PermissionManager under capability
// "documents", then dispatches to DocumentService. Results serialize to
// bounded JSON with provenance; denials and failures return isError: true.

import {
  buildAllDocumentsToolDefinitions,
  DocumentsDeleteInputSchema,
  DocumentsListInputSchema,
  DocumentsOpenInputSchema,
  DocumentsSearchInputSchema,
  documentsRiskFor,
  isDocumentsToolId,
  type DocumentsActionType,
  type DocumentsToolId,
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
import { toCanonicalDocumentError } from "./document-errors.js";
import type { DocumentService } from "./document-service.js";

export interface DocumentsToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly documentService: DocumentService;
}

export interface ExecuteDocumentsToolOptions {
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
  readonly action: DocumentsActionType;
  readonly schema: SchemaValidator;
  readonly getResource: (parsed: Record<string, unknown>) => string;
}

function stringField(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key];
  return typeof value === "string" ? value : "";
}

const TOOL_CONFIGS: Record<DocumentsToolId, ToolConfig> = {
  "builtin:documents.list": {
    action: "list",
    schema: DocumentsListInputSchema,
    getResource: (p) => `builtin:documents.list::${stringField(p, "projectId").slice(0, 128)}`,
  },
  "builtin:documents.search": {
    action: "search",
    schema: DocumentsSearchInputSchema,
    getResource: (p) =>
      `builtin:documents.search::${stringField(p, "projectId").slice(0, 128)}/${stringField(p, "query").slice(0, 200)}`,
  },
  "builtin:documents.open": {
    action: "open",
    schema: DocumentsOpenInputSchema,
    getResource: (p) =>
      `builtin:documents.open::${stringField(p, "projectId").slice(0, 128)}/${stringField(p, "documentId").slice(0, 64)}`,
  },
  "builtin:documents.delete": {
    action: "delete",
    schema: DocumentsDeleteInputSchema,
    getResource: (p) =>
      `builtin:documents.delete::${stringField(p, "projectId").slice(0, 128)}/${stringField(p, "documentId").slice(0, 64)}`,
  },
};

export class DocumentsToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _documentService: DocumentService;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: DocumentsToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._documentService = deps.documentService;
    for (const def of buildAllDocumentsToolDefinitions()) {
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
    options?: ExecuteDocumentsToolOptions,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const toolCallId = options?.toolCallId ?? createToolCallId();

    // 1. Resolve tool definition.
    if (!isDocumentsToolId(toolName)) {
      throw new ValidationError(`Unknown documents tool "${toolName}"`);
    }
    const toolDef = this._definitions.get(toolName);
    const config = TOOL_CONFIGS[toolName];
    if (!toolDef || !config) {
      throw new ValidationError(`Documents tool "${toolName}" is not registered`);
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

    // 3. PermissionManager check (capability "documents").
    const convId =
      typeof options?.conversationId === "string"
        ? (options.conversationId as ConversationId)
        : undefined;
    const permResult = await this._permissionManager.check(
      {
        capability: "documents",
        action: config.action,
        resource: config.getResource(validated),
        scope: "once",
        risk: documentsRiskFor(config.action),
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

    // 4. Dispatch to DocumentService.
    const projectId =
      typeof validated["projectId"] === "string"
        ? (validated["projectId"] as string)
        : (options?.projectId ?? "default");
    try {
      let outcome: unknown;
      switch (toolName) {
        case "builtin:documents.list":
          outcome = await this._documentService.list({ projectId });
          break;
        case "builtin:documents.search":
          outcome = await this._documentService.search({
            projectId,
            query: String(validated["query"]),
            ...(typeof validated["limit"] === "number" ? { limit: validated["limit"] } : {}),
          });
          break;
        case "builtin:documents.open":
          outcome = await this._documentService.open({
            projectId,
            documentId: String(validated["documentId"]),
            ...(typeof validated["maxChars"] === "number"
              ? { maxChars: validated["maxChars"] }
              : {}),
          });
          break;
        case "builtin:documents.delete":
          outcome = await this._documentService.remove({
            projectId,
            documentId: String(validated["documentId"]),
          });
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
      const canonical = toCanonicalDocumentError(err);
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
