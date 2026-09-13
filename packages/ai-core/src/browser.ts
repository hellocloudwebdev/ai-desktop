// PR34: packages/ai-core — Canonical Browser Automation Contracts
//
// Invariants:
//   1. Browser domain contracts are pure: branded IDs, semantic element references,
//      and explicit lifecycle states. Zero Puppeteer, Playwright, or Electron imports.
//   2. Browser tools have source="builtin" and runtime="browser". Execution is mediated
//      by PermissionManager with requiredPermissions=["browser"].
//   3. URLs must pass safety checks: dangerous schemes (javascript, vbscript, data, file,
//      blob) are strictly rejected; only http, https, and about:blank are allowed.
//   4. Sensitive field values (passwords, tokens, keys) must be redacted before being
//      stored or logged.
//   5. Element references use semantic formats (e.g. "ref/e1", "e12") and are unique per snapshot.

import { z } from "zod";
import { TimestampStringSchema } from "@ai-desktop/shared";
import {
  BrowserSessionIdSchema,
  BrowserContextIdSchema,
  BrowserPageIdSchema,
  BrowserElementRefSchema,
} from "./identifiers.js";
import type { ToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// Browser Session & Context Schemas
// ---------------------------------------------------------------------------

export const BrowserSessionModeSchema = z.enum(["isolated", "attached"]);
export type BrowserSessionMode = z.infer<typeof BrowserSessionModeSchema>;

export const BrowserSessionStatusSchema = z.enum([
  "starting",
  "ready",
  "closing",
  "closed",
  "failed",
]);
export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatusSchema>;

export const BrowserSessionSchema = z.object({
  id: BrowserSessionIdSchema,
  projectId: z.string().trim().min(1),
  mode: BrowserSessionModeSchema.default("isolated"),
  status: BrowserSessionStatusSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

export const BrowserPersistenceModeSchema = z.enum(["ephemeral", "persistent"]);
export type BrowserPersistenceMode = z.infer<typeof BrowserPersistenceModeSchema>;

export const BrowserContextSchema = z.object({
  id: BrowserContextIdSchema,
  sessionId: BrowserSessionIdSchema,
  persistenceMode: BrowserPersistenceModeSchema.default("ephemeral"),
  createdAt: TimestampStringSchema,
});
export type BrowserContext = z.infer<typeof BrowserContextSchema>;

// ---------------------------------------------------------------------------
// Browser Page & Snapshot Schemas
// ---------------------------------------------------------------------------

export const BrowserPageStatusSchema = z.enum(["loading", "ready", "closed", "error"]);
export type BrowserPageStatus = z.infer<typeof BrowserPageStatusSchema>;

export const BrowserPageSchema = z.object({
  id: BrowserPageIdSchema,
  contextId: BrowserContextIdSchema,
  name: z.string().trim().optional(),
  url: z.string().trim(),
  title: z.string().trim().max(200).default(""),
  status: BrowserPageStatusSchema.default("ready"),
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema.optional(),
});
export type BrowserPage = z.infer<typeof BrowserPageSchema>;

export const BrowserElementInfoSchema = z.object({
  ref: BrowserElementRefSchema,
  role: z.string().trim(),
  name: z.string().trim().default(""),
  text: z.string().trim().optional(),
  value: z.string().trim().optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selector: z.string().trim().optional(),
});
export type BrowserElementInfo = z.infer<typeof BrowserElementInfoSchema>;

export const BrowserSnapshotSchema = z.object({
  pageId: BrowserPageIdSchema,
  url: z.string().trim(),
  title: z.string().trim().max(200),
  text: z.string().trim(),
  elements: z.array(BrowserElementInfoSchema),
  truncated: z.boolean().default(false),
  timestamp: TimestampStringSchema,
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

// ---------------------------------------------------------------------------
// Browser Tools Canonical IDs
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_IDS = [
  "builtin:browser.open",
  "builtin:browser.navigate",
  "builtin:browser.pages",
  "builtin:browser.snapshot",
  "builtin:browser.click",
  "builtin:browser.fill",
  "builtin:browser.select",
  "builtin:browser.press",
  "builtin:browser.wait",
  "builtin:browser.screenshot",
  "builtin:browser.close",
] as const;

export type BrowserToolId = (typeof BROWSER_TOOL_IDS)[number];

export function isBrowserToolId(value: string): value is BrowserToolId {
  return (BROWSER_TOOL_IDS as readonly string[]).includes(value as BrowserToolId);
}

// ---------------------------------------------------------------------------
// Browser Actions & Action Input Schemas
// ---------------------------------------------------------------------------

export const BrowserActionTypeSchema = z.enum([
  "open",
  "navigate",
  "pages",
  "snapshot",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "screenshot",
  "close",
]);
export type BrowserActionType = z.infer<typeof BrowserActionTypeSchema>;

export const BrowserOpenInputSchema = z.object({
  url: z.string().trim().min(1),
  name: z.string().trim().optional(),
});
export type BrowserOpenInput = z.infer<typeof BrowserOpenInputSchema>;

export const BrowserNavigateInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  url: z.string().trim().min(1),
});
export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInputSchema>;

export const BrowserPagesInputSchema = z
  .object({
    sessionId: BrowserSessionIdSchema.optional(),
  })
  .default({});
export type BrowserPagesInput = z.infer<typeof BrowserPagesInputSchema>;

export const BrowserSnapshotInputSchema = z.object({
  pageId: BrowserPageIdSchema,
});
export type BrowserSnapshotInput = z.infer<typeof BrowserSnapshotInputSchema>;

export const BrowserClickInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  ref: BrowserElementRefSchema,
});
export type BrowserClickInput = z.infer<typeof BrowserClickInputSchema>;

export const BrowserFillInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  ref: BrowserElementRefSchema,
  value: z.string(),
});
export type BrowserFillInput = z.infer<typeof BrowserFillInputSchema>;

export const BrowserSelectInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  ref: BrowserElementRefSchema,
  values: z.array(z.string()),
});
export type BrowserSelectInput = z.infer<typeof BrowserSelectInputSchema>;

export const BrowserPressInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  key: z.string().min(1),
});
export type BrowserPressInput = z.infer<typeof BrowserPressInputSchema>;

export const BrowserWaitInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  condition: z.enum(["navigation", "selector", "timeout"]),
  target: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60000).optional(),
});
export type BrowserWaitInput = z.infer<typeof BrowserWaitInputSchema>;

export const BrowserScreenshotInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  fullPage: z.boolean().optional().default(false),
});
export type BrowserScreenshotInput = z.infer<typeof BrowserScreenshotInputSchema>;

export const BrowserCloseInputSchema = z.object({
  pageId: BrowserPageIdSchema,
});
export type BrowserCloseInput = z.infer<typeof BrowserCloseInputSchema>;

// ---------------------------------------------------------------------------
// Tool Parameters Schemas & Definitions
// ---------------------------------------------------------------------------

export function browserToolParameters(toolId: BrowserToolId): Record<string, unknown> {
  switch (toolId) {
    case "builtin:browser.open":
      return {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to open in a new page" },
          name: { type: "string", description: "Optional logical page name" },
        },
      };
    case "builtin:browser.navigate":
      return {
        type: "object",
        required: ["pageId", "url"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          url: { type: "string", description: "Target URL to navigate to" },
        },
      };
    case "builtin:browser.pages":
      return {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional browser session ULID filter" },
        },
      };
    case "builtin:browser.snapshot":
      return {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
        },
      };
    case "builtin:browser.click":
      return {
        type: "object",
        required: ["pageId", "ref"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          ref: { type: "string", description: "Element reference from snapshot (e.g. 'ref/e1')" },
        },
      };
    case "builtin:browser.fill":
      return {
        type: "object",
        required: ["pageId", "ref", "value"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          ref: { type: "string", description: "Element reference from snapshot (e.g. 'ref/e1')" },
          value: { type: "string", description: "Value to input into the element" },
        },
      };
    case "builtin:browser.select":
      return {
        type: "object",
        required: ["pageId", "ref", "values"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          ref: { type: "string", description: "Element reference from snapshot (e.g. 'ref/e1')" },
          values: {
            type: "array",
            items: { type: "string" },
            description: "Option values to select",
          },
        },
      };
    case "builtin:browser.press":
      return {
        type: "object",
        required: ["pageId", "key"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'ArrowDown')" },
        },
      };
    case "builtin:browser.wait":
      return {
        type: "object",
        required: ["pageId", "condition"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          condition: {
            type: "string",
            enum: ["navigation", "selector", "timeout"],
            description: "Wait condition",
          },
          target: {
            type: "string",
            description: "Target selector or details when condition is 'selector'",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout duration in milliseconds (max 60000)",
          },
        },
      };
    case "builtin:browser.screenshot":
      return {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID" },
          fullPage: { type: "boolean", description: "Whether to capture full scrollable page" },
        },
      };
    case "builtin:browser.close":
      return {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string", description: "Browser page ULID to close" },
        },
      };
  }
}

export function browserToolDescription(toolId: BrowserToolId): string {
  switch (toolId) {
    case "builtin:browser.open":
      return "Opens a URL in a new browser page and returns page metadata.";
    case "builtin:browser.navigate":
      return "Navigates an existing browser page to a new URL.";
    case "builtin:browser.pages":
      return "Lists all open browser pages and their status across sessions.";
    case "builtin:browser.snapshot":
      return "Takes an accessibility and semantic DOM snapshot of a browser page with element references.";
    case "builtin:browser.click":
      return "Clicks an element identified by its semantic element reference.";
    case "builtin:browser.fill":
      return "Fills an input or editable element identified by its semantic element reference.";
    case "builtin:browser.select":
      return "Selects options in a select element identified by its semantic element reference.";
    case "builtin:browser.press":
      return "Sends a keyboard key press to an active browser page.";
    case "builtin:browser.wait":
      return "Waits for a condition (navigation, selector, or timeout) on a browser page.";
    case "builtin:browser.screenshot":
      return "Captures a visual screenshot of a browser page.";
    case "builtin:browser.close":
      return "Closes a browser page and releases associated resources.";
  }
}

export function buildBrowserToolDefinition(toolId: BrowserToolId): ToolDefinition {
  return {
    name: toolId,
    description: browserToolDescription(toolId),
    source: "builtin",
    runtime: "browser",
    parameters: browserToolParameters(toolId),
    requiredPermissions: ["browser"],
  };
}

export function buildAllBrowserToolDefinitions(): ToolDefinition[] {
  return BROWSER_TOOL_IDS.map(buildBrowserToolDefinition);
}

// ---------------------------------------------------------------------------
// URL Validation & Policy
// ---------------------------------------------------------------------------

export const DANGEROUS_BROWSER_URL_PATTERN = /^\s*(javascript|vbscript|data|file|blob):/i;

export function isSafeBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || !url.trim()) {
    return false;
  }

  const trimmed = url.trim();

  if (DANGEROUS_BROWSER_URL_PATTERN.test(trimmed)) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return true;
    }
    if (parsed.protocol === "about:" && parsed.pathname === "blank") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redaction & Limits Constants
// ---------------------------------------------------------------------------

export const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_SNAPSHOT_ELEMENTS = 200;
export const MAX_PAGE_TITLE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 10000;
export const MAX_SESSIONS = 10;
export const MAX_PAGES_PER_SESSION = 20;
export const MAX_ACTION_DURATION_MS = 60000;

export const SENSITIVE_FIELD_PATTERN =
  /(password|passcode|token|secret|api[_-]?key|credit[_-]?card|auth)/i;

export function isSensitiveField(name: string): boolean {
  if (typeof name !== "string") {
    return false;
  }
  return SENSITIVE_FIELD_PATTERN.test(name);
}

export function redactSensitiveValue(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return "[REDACTED]";
}

// ---------------------------------------------------------------------------
// Capability and Risk
// ---------------------------------------------------------------------------

export function browserRiskFor(action: string, fieldName?: string): "low" | "medium" | "high" {
  switch (action) {
    case "snapshot":
    case "pages":
      return "low";
    case "fill":
      if (fieldName && isSensitiveField(fieldName)) {
        return "high";
      }
      return "medium";
    case "open":
    case "navigate":
    case "click":
    case "select":
    case "press":
    case "wait":
    case "screenshot":
    case "close":
    default:
      return "medium";
  }
}
