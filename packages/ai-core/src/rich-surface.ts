// PR33: packages/ai-core — Canonical Rich-Surface Contracts
//
// Invariants:
//   1. Rich-surface descriptors are pure domain contracts: branded IDs, SemVer
//      versions, explicit kinds. No DOM, rendering, or Electron.
//   2. All surface kinds are recognized, but only RENDERABLE_KINDS
//      (document/table/form) are render-enabled by host policy; chart and
//      application are recognized but render-disabled in PR33.
//   3. Every surface instance is provenance-bound: source, originId, and
//      toolCallId are required, never optional.
//   4. No secrets embedded in descriptors: title and metadata reject raw
//      credentials (API keys, tokens, private keys, passwords).
//   5. ToolResult integration is additive only: executors stamp
//      metadata.surface via buildSurfaceMetadata; readers use
//      extractSurfaceDescriptor, which never throws.
//   6. URL/path guards are syntactic only: isSafeSurfaceUrl rejects dangerous
//      schemes, isSafeSurfacePath rejects traversal and NUL bytes.

import { z } from "zod";
import {
  ToolCallIdSchema,
  TimestampStringSchema,
  generateUlid,
  isUlid,
  type Brand,
  type Timestamp,
} from "@ai-desktop/shared";
import { ToolSourceSchema } from "./tools.js";
import { containsRawCredential } from "./memory.js";

/** All surface kinds recognized by the domain (superset of renderable kinds). */
export const SURFACE_KINDS = ["document", "table", "form", "chart", "application"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * Host policy default: only document/table/form render in PR33.
 * Chart and application are recognized but render-disabled.
 */
export const RENDERABLE_KINDS = ["document", "table", "form"] as const;
export type RenderableKind = (typeof RENDERABLE_KINDS)[number];

export const SURFACE_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SurfaceVersionSchema = z.string().trim().regex(SURFACE_SEMVER_PATTERN, {
  message: "Version must be valid SemVer (e.g. 1.0.0)",
});

export type SurfaceId = Brand<string, "SurfaceId">;

export const SurfaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "SurfaceId must be lowercase alphanumeric with optional dot/dash/underscore/colon",
  })
  .transform((val) => val.toLowerCase() as SurfaceId);

export type SurfaceInstanceId = Brand<string, "SurfaceInstanceId">;

const SURFACE_INSTANCE_ID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const SurfaceInstanceUlidSchema = z.string().trim().regex(SURFACE_INSTANCE_ID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const SurfaceInstanceIdSchema = SurfaceInstanceUlidSchema.transform(
  (val) => val.toUpperCase() as SurfaceInstanceId,
);

export function createSurfaceInstanceId(seedTime?: number): SurfaceInstanceId {
  return generateUlid(seedTime) as SurfaceInstanceId;
}

export function parseSurfaceInstanceId(raw: string): SurfaceInstanceId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid SurfaceInstanceId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as SurfaceInstanceId;
}

export function asSurfaceInstanceId(raw: string): SurfaceInstanceId {
  return raw as SurfaceInstanceId;
}

const NoCredentialRefine = {
  message: "Value must not contain raw credentials (API keys, tokens, private keys, passwords)",
};

export const RichSurfaceDescriptorSchema = z.object({
  id: SurfaceIdSchema,
  version: SurfaceVersionSchema,
  kind: z.enum(SURFACE_KINDS),
  title: z.string().trim().min(1).max(200).optional(),
  dataSchema: z.record(z.string(), z.unknown()).optional().default({}),
  interactionSchema: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RichSurfaceDescriptor = z.infer<typeof RichSurfaceDescriptorSchema>;

export const SurfaceProvenanceSchema = z.object({
  source: ToolSourceSchema,
  originId: z.string().trim().min(1).max(256),
  toolCallId: ToolCallIdSchema,
  projectId: z.string().trim().min(1).max(256).optional(),
});

export type SurfaceProvenance = z.infer<typeof SurfaceProvenanceSchema>;

export const SurfaceStatusSchema = z.enum([
  "declared",
  "validated",
  "mounted",
  "active",
  "disposed",
]);
export type SurfaceStatus = z.infer<typeof SurfaceStatusSchema>;

export const SurfaceInstanceSchema = z.object({
  instanceId: SurfaceInstanceIdSchema,
  descriptor: RichSurfaceDescriptorSchema,
  provenance: SurfaceProvenanceSchema,
  status: SurfaceStatusSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema.optional(),
});

export type SurfaceInstance = {
  readonly instanceId: SurfaceInstanceId;
  readonly descriptor: RichSurfaceDescriptor;
  readonly provenance: SurfaceProvenance;
  readonly status: SurfaceStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt?: Timestamp;
};

export const SurfaceActionTypeSchema = z.enum([
  "submit",
  "select",
  "refresh",
  "open",
  "navigate",
  "copy",
]);
export type SurfaceActionType = z.infer<typeof SurfaceActionTypeSchema>;

export const SurfaceActionSchema = z.object({
  actionId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/, {
      message: "ActionId must be lowercase alphanumeric with optional dot/dash/underscore/colon",
    }),
  type: SurfaceActionTypeSchema,
  inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
  toolName: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(200).optional(),
});

export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

export const DANGEROUS_URL_PATTERN = /^\s*(javascript|vbscript|data|file|blob):/i;
export const TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * Syntactic URL guard: accepts http/https, relative URLs, and fragments;
 * rejects non-strings, empty/oversized values, and dangerous schemes.
 */
export function isSafeSurfaceUrl(url: unknown): boolean {
  if (typeof url !== "string") {
    return false;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return false;
  }
  return !DANGEROUS_URL_PATTERN.test(trimmed);
}

/**
 * Syntactic path guard: rejects non-strings, empty/oversized values,
 * directory traversal segments, and NUL bytes.
 */
export function isSafeSurfacePath(p: unknown): boolean {
  if (typeof p !== "string") {
    return false;
  }
  if (p.length === 0 || p.length > 1024) {
    return false;
  }
  if (p.includes("\0")) {
    return false;
  }
  return !TRAVERSAL_PATTERN.test(p);
}

export const MAX_SURFACE_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_SURFACE_DATA_BYTES = 256 * 1024;
export const MAX_SURFACE_ROWS = 500;
export const MAX_SURFACE_COLUMNS = 50;
export const MAX_SURFACE_FIELDS = 50;
export const MAX_SURFACE_ACTIONS = 20;
export const MAX_SURFACES_PER_TASK = 20;

/**
 * Validates a rich-surface descriptor against the canonical contract.
 * Structural validation only; ZodError propagates on schema failure.
 * Titles and metadata carrying raw credentials are rejected.
 */
export function validateSurfaceDescriptor(input: unknown): RichSurfaceDescriptor {
  const parsed = RichSurfaceDescriptorSchema.parse(input);
  if (parsed.title !== undefined && containsRawCredential(parsed.title)) {
    throw new Error(NoCredentialRefine.message);
  }
  if (parsed.metadata !== undefined && containsRawCredential(JSON.stringify(parsed.metadata))) {
    throw new Error(NoCredentialRefine.message);
  }
  return parsed;
}

/**
 * Validates a surface action against the canonical contract.
 * ZodError propagates on schema failure.
 */
export function validateSurfaceAction(input: unknown): SurfaceAction {
  return SurfaceActionSchema.parse(input);
}

/**
 * The additive ToolResult convention: executors stamp metadata.surface
 * with the descriptor; no existing metadata keys are touched.
 */
export function buildSurfaceMetadata(descriptor: RichSurfaceDescriptor): {
  surface: RichSurfaceDescriptor;
} {
  return { surface: descriptor };
}

/**
 * Reads a descriptor stamped by buildSurfaceMetadata. Returns null for
 * missing or invalid payloads; never throws.
 */
export function extractSurfaceDescriptor(metadata: unknown): RichSurfaceDescriptor | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const parsed = RichSurfaceDescriptorSchema.safeParse((metadata as { surface?: unknown }).surface);
  return parsed.success ? parsed.data : null;
}
