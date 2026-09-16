// PR38: packages/mcp — MCP App surface bridge (pure descriptor builder + action validator)
//
// Invariants:
//   1. Pure functions: no I/O, no host access, no SDK imports. Only types and
//      bounds from @ai-desktop/ai-core.
//   2. Only document|table|form descriptors are ever produced; chart and
//      application are recognized but never emitted (render-disabled in PR33).
//   3. Payloads over MCP_MAX_SURFACE_PAYLOAD_BYTES (128 KB) yield undefined.
//      The SurfaceService binding + permission path stays the enforcement point;
//      this cap is fail-closed input hygiene at the bridge.
//   4. Provenance is stamped into descriptor metadata as
//      { source: "mcp", originId: serverId }. The toolCallId binding happens at
//      SurfaceService registration from the live ToolResult, which is the
//      provenance authority — never from untrusted tool metadata.

import { MCP_MAX_SURFACE_PAYLOAD_BYTES, type RichSurfaceDescriptor } from "@ai-desktop/ai-core";

/**
 * Minimal ToolResult shape the bridge consumes. Only toolName + metadata are
 * read; the full ToolResult (and its toolCallId authority) stays host-side.
 */
export interface McpAppToolResultInput {
  readonly toolName: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const SURFACE_ID_MAX = 64;
const TABLE_COLUMN_CAP = 50;
const FORM_FIELD_CAP = 50;
const DESCRIPTOR_VERSION = "1.0.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the server segment from a canonical `mcp:<server>/<tool>` id.
 * Non-canonical tool names yield "unknown" (never throws; the validator and
 * the SurfaceService binding check stay authoritative for forgery).
 */
function parseMcpServerId(toolName: string): string {
  if (toolName.startsWith("mcp:")) {
    const rest = toolName.slice("mcp:".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const server = rest.slice(0, slash).trim();
      if (server.length > 0) return server;
    }
  }
  return "unknown";
}

/**
 * Derives a valid SurfaceId (lowercase alphanumeric + dot/dash/underscore/
 * colon, max 64 chars) from an arbitrary tool name. Never throws.
 */
function sanitizeSurfaceId(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  const trimmed = lowered.replace(/^[^a-z0-9]+/, "").slice(0, SURFACE_ID_MAX);
  return trimmed.length > 0 ? trimmed : "mcp.app.surface";
}

interface PartitionedContents {
  readonly texts: string[];
  readonly images: number;
  readonly structured: Record<string, unknown>[];
}

/**
 * Splits metadata.structuredContents entries by kind. Text and image blocks
 * render as documents; structured payloads resolve to table/form/document by
 * shape. Audio/resource-only payloads are not renderable (undefined upstream).
 */
function partitionContents(contents: readonly unknown[]): PartitionedContents {
  const texts: string[] = [];
  let images = 0;
  const structured: Record<string, unknown>[] = [];
  for (const entry of contents) {
    if (!isRecord(entry)) continue;
    const kind = entry["kind"];
    if (kind === "text" && typeof entry["text"] === "string") {
      texts.push(entry["text"]);
    } else if (kind === "image") {
      images += 1;
    } else if (kind === "structured" && isRecord(entry["structured"])) {
      structured.push(entry["structured"]);
    }
  }
  return { texts, images, structured };
}

/**
 * Table-ish shape: a `rows` array of objects (or explicit string `columns`
 * alongside `rows`). Returns the ordered union of row keys, or null.
 */
function tableColumnsFor(payload: Record<string, unknown>): string[] | null {
  const rows = payload["rows"];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const explicit = payload["columns"];
  if (Array.isArray(explicit) && explicit.every((c): c is string => typeof c === "string")) {
    const cols = explicit.slice(0, TABLE_COLUMN_CAP);
    return cols.length > 0 ? cols : null;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (key.length > 0 && key.length <= 128) seen.add(key);
      if (seen.size >= TABLE_COLUMN_CAP) break;
    }
    if (seen.size >= TABLE_COLUMN_CAP) break;
  }
  return seen.size > 0 ? [...seen] : null;
}

/**
 * Form-ish shape: a `fields` array of objects carrying a string `name`.
 * Returns field names, or null.
 */
function formFieldsFor(payload: Record<string, unknown>): string[] | null {
  const fields = payload["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const names: string[] = [];
  for (const field of fields) {
    if (isRecord(field) && typeof field["name"] === "string" && field["name"].length > 0) {
      names.push(field["name"]);
    }
    if (names.length >= FORM_FIELD_CAP) break;
  }
  return names.length > 0 ? names : null;
}

function provenanceMetadata(serverId: string, toolName: string): Record<string, unknown> {
  return {
    provenance: { source: "mcp", originId: serverId },
    toolName,
  };
}

/**
 * Converts tool-result structured content into a document|table surface
 * descriptor. Returns undefined when there is nothing renderable (no
 * structuredContents, audio/resource-only payloads) or when the payload
 * exceeds MCP_MAX_SURFACE_PAYLOAD_BYTES. Chart/application are never emitted.
 */
export function buildMcpAppDescriptor(
  toolResult: McpAppToolResultInput,
): RichSurfaceDescriptor | undefined {
  if (!toolResult || typeof toolResult.toolName !== "string" || toolResult.toolName.length === 0) {
    return undefined;
  }
  if (!isRecord(toolResult.metadata)) return undefined;
  const contents = toolResult.metadata["structuredContents"];
  if (!Array.isArray(contents) || contents.length === 0) return undefined;

  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(contents), "utf8");
  } catch {
    return undefined;
  }
  if (payloadBytes > MCP_MAX_SURFACE_PAYLOAD_BYTES) return undefined;

  const { texts, images, structured } = partitionContents(contents);

  let tableColumns: string[] | null = null;
  let formFields: string[] | null = null;
  for (const payload of structured) {
    if (!tableColumns) tableColumns = tableColumnsFor(payload);
    if (!formFields) formFields = formFieldsFor(payload);
  }

  const serverId = parseMcpServerId(toolResult.toolName);
  const id = sanitizeSurfaceId(
    `mcp.app.${serverId}.${toolResult.toolName}`,
  ) as RichSurfaceDescriptor["id"];
  const title = toolResult.toolName.slice(0, 200);
  const metadata = provenanceMetadata(serverId, toolResult.toolName);

  if (tableColumns) {
    return {
      id,
      version: DESCRIPTOR_VERSION,
      kind: "table",
      title,
      dataSchema: { columns: tableColumns },
      metadata,
    };
  }
  if (formFields) {
    return {
      id,
      version: DESCRIPTOR_VERSION,
      kind: "form",
      title,
      dataSchema: { fields: formFields },
      metadata,
    };
  }
  if (texts.length > 0 || images > 0 || structured.length > 0) {
    return {
      id,
      version: DESCRIPTOR_VERSION,
      kind: "document",
      title,
      dataSchema: {},
      metadata,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Action validation (fail-closed, pure)
// ---------------------------------------------------------------------------

/** Surface action invocation request crossing into the MCP App bridge. */
export interface McpAppActionInput {
  readonly instanceId: string;
  readonly actionId: string;
  readonly input: unknown;
  readonly projectId: string;
  readonly serverId: string;
  readonly toolName: string;
}

/** Registered binding authority for one tool: origin + granted capabilities. */
export interface McpAppActionBinding {
  readonly originId: string;
  readonly projectId?: string;
  readonly capabilities: readonly string[];
}

/**
 * Lookup context for validation. Bindings are keyed by canonical tool name;
 * instanceProjects maps surface instance ids to their owning project.
 * Absent context fails closed (unknown binding).
 */
export interface McpAppActionContext {
  readonly bindings?: Readonly<Record<string, McpAppActionBinding>>;
  readonly instanceProjects?: Readonly<Record<string, string>>;
}

export type McpAppActionResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(reason: string): McpAppActionResult {
  return { ok: false, reason };
}

/**
 * Validates an MCP App surface action fail-closed:
 *   - structural: instanceId/actionId/projectId/serverId/toolName must be
 *     non-empty strings (input carries the action payload, validated
 *     host-side against the action schema at invoke time);
 *   - unknown tool binding or ungranted actionId/capability is rejected;
 *   - serverId must equal the binding originId (forgery rejected);
 *   - projectId must equal the instance (or binding) project when one is
 *     known (cross-project rejected).
 */
export function validateMcpAppAction(
  action: McpAppActionInput,
  context?: McpAppActionContext,
): McpAppActionResult {
  if (!action || typeof action !== "object") return fail("action must be an object");
  const fields = [
    ["instanceId", action.instanceId],
    ["actionId", action.actionId],
    ["projectId", action.projectId],
    ["serverId", action.serverId],
    ["toolName", action.toolName],
  ] as const;
  for (const [field, value] of fields) {
    if (!nonEmptyString(value)) return fail(`invalid ${field}: must be a non-empty string`);
  }
  const binding = context?.bindings?.[action.toolName];
  if (!binding) {
    return fail(
      `unknown action "${action.actionId}" for tool "${action.toolName}": no surface binding registered`,
    );
  }
  if (!binding.capabilities.includes(action.actionId)) {
    return fail(
      `unknown action "${action.actionId}" for tool "${action.toolName}": capability not granted`,
    );
  }
  if (action.serverId !== binding.originId) {
    return fail(`forged serverId "${action.serverId}": binding origin is "${binding.originId}"`);
  }
  const expectedProject = context?.instanceProjects?.[action.instanceId] ?? binding.projectId;
  if (expectedProject !== undefined && action.projectId !== expectedProject) {
    return fail(`cross-project action: instance is bound to project "${expectedProject}"`);
  }
  return { ok: true };
}
