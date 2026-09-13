// PR34.4: apps/desktop — Browser Tool Executor
//
// Invariants:
//   1. Satisfies ToolExecutorLike contract: execute(toolName, input, options).
//   2. Strict order of execution:
//      a. Resolve tool definition (from BROWSER_TOOL_IDS).
//      b. Validate input schema with corresponding Browser*InputSchema; throw ValidationError if invalid before permission check.
//      c. Check PermissionManager with capability "browser", action, resource, scope "once", and risk.
//      d. Dispatch to BrowserService with project isolation.
//      e. Format result into canonical ToolResult.

import {
  type BrowserActionType,
  BrowserClickInputSchema,
  BrowserCloseInputSchema,
  BrowserFillInputSchema,
  BrowserNavigateInputSchema,
  BrowserOpenInputSchema,
  BrowserPagesInputSchema,
  BrowserPressInputSchema,
  browserRiskFor,
  BrowserScreenshotInputSchema,
  BrowserSelectInputSchema,
  BrowserSnapshotInputSchema,
  BrowserWaitInputSchema,
  buildAllBrowserToolDefinitions,
  isBrowserToolId,
  type BrowserToolId,
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
import { toCanonicalBrowserError } from "./browser-errors.js";
import type { BrowserService } from "./browser-service.js";

export interface BrowserToolExecutorDeps {
  readonly permissionManager: PermissionManager;
  readonly browserService: BrowserService;
}

export interface ExecuteBrowserToolOptions {
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
  readonly action: BrowserActionType;
  readonly schema: SchemaValidator;
  readonly getResource: (parsed: Record<string, unknown>) => string;
  readonly getFieldName?: (parsed: Record<string, unknown>) => string | undefined;
}

const TOOL_CONFIGS: Record<BrowserToolId, ToolConfig> = {
  "builtin:browser.open": {
    action: "open",
    schema: BrowserOpenInputSchema,
    getResource: (p) => `builtin:browser.open::${String(p.url ?? "")}`,
  },
  "builtin:browser.navigate": {
    action: "navigate",
    schema: BrowserNavigateInputSchema,
    getResource: (p) => `builtin:browser.navigate::${String(p.url ?? "")}`,
  },
  "builtin:browser.pages": {
    action: "pages",
    schema: BrowserPagesInputSchema,
    getResource: (p) => `builtin:browser.pages::${String(p.sessionId ?? "all")}`,
  },
  "builtin:browser.snapshot": {
    action: "snapshot",
    schema: BrowserSnapshotInputSchema,
    getResource: (p) => `builtin:browser.snapshot::${String(p.pageId ?? "")}`,
  },
  "builtin:browser.click": {
    action: "click",
    schema: BrowserClickInputSchema,
    getResource: (p) => `builtin:browser.click::${String(p.ref ?? "")}`,
  },
  "builtin:browser.fill": {
    action: "fill",
    schema: BrowserFillInputSchema,
    getResource: (p) => `builtin:browser.fill::${String(p.ref ?? "")}`,
    getFieldName: (p) => (typeof p.ref === "string" ? p.ref : undefined),
  },
  "builtin:browser.select": {
    action: "select",
    schema: BrowserSelectInputSchema,
    getResource: (p) => `builtin:browser.select::${String(p.ref ?? "")}`,
  },
  "builtin:browser.press": {
    action: "press",
    schema: BrowserPressInputSchema,
    getResource: (p) => `builtin:browser.press::${String(p.pageId ?? "")}`,
  },
  "builtin:browser.wait": {
    action: "wait",
    schema: BrowserWaitInputSchema,
    getResource: (p) => `builtin:browser.wait::${String(p.pageId ?? "")}`,
  },
  "builtin:browser.screenshot": {
    action: "screenshot",
    schema: BrowserScreenshotInputSchema,
    getResource: (p) => `builtin:browser.screenshot::${String(p.pageId ?? "")}`,
  },
  "builtin:browser.close": {
    action: "close",
    schema: BrowserCloseInputSchema,
    getResource: (p) => `builtin:browser.close::${String(p.pageId ?? "")}`,
  },
};

export class BrowserToolExecutor {
  private readonly _permissionManager: PermissionManager;
  private readonly _browserService: BrowserService;
  private readonly _definitions = new Map<string, ToolDefinition>();

  constructor(deps: BrowserToolExecutorDeps) {
    this._permissionManager = deps.permissionManager;
    this._browserService = deps.browserService;

    for (const def of buildAllBrowserToolDefinitions()) {
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
    options?: ExecuteBrowserToolOptions,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const toolCallId = options?.toolCallId ?? createToolCallId();

    // 1. Resolve tool definition
    if (!isBrowserToolId(toolName)) {
      throw new ValidationError(`Unknown browser tool "${toolName}"`);
    }

    const toolDef = this._definitions.get(toolName);
    const config = TOOL_CONFIGS[toolName];
    if (!toolDef || !config) {
      throw new ValidationError(`Browser tool "${toolName}" is not registered`);
    }

    // 2. Validate input schema using Zod schema BEFORE permission check
    const parseResult = config.schema.safeParse(input);
    if (!parseResult.success) {
      throw new ValidationError(
        `Input validation failed for tool "${toolName}": ${parseResult.error.message}`,
        { cause: parseResult.error },
      );
    }
    const validatedInput = parseResult.data as Record<string, unknown>;

    // 3. PermissionManager check
    const resource = config.getResource(validatedInput);
    const fieldName = config.getFieldName ? config.getFieldName(validatedInput) : undefined;
    const risk = browserRiskFor(config.action, fieldName);

    const convId =
      typeof options?.conversationId === "string"
        ? (options.conversationId as ConversationId)
        : undefined;

    const permResult = await this._permissionManager.check(
      {
        capability: "browser",
        action: config.action,
        resource,
        scope: "once",
        risk,
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

    // 4. Dispatch to BrowserService
    try {
      const outcome = await this._browserService.executeAction(config.action, validatedInput, {
        projectId: options?.projectId ?? "default",
        toolCallId,
        signal: options?.signal,
      });

      // 5. Format result into canonical ToolResult
      return {
        toolCallId,
        toolName,
        result: typeof outcome === "string" ? outcome : JSON.stringify(outcome),
        isError: false,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    } catch (err: unknown) {
      const canonicalErr = toCanonicalBrowserError(err);
      return {
        toolCallId,
        toolName,
        result: `[${canonicalErr.code}] ${canonicalErr.message}`,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: now(),
      };
    }
  }
}
