// PR32: packages/plugins — Extension Manifest & Lifecycle Contract
//
// Invariants:
//   1. Extension is an installable package, NOT an agent (does not own an agent loop).
//   2. Lifecycle states: installed -> enabled -> active, plus disabled and
//      uninstalled (terminal removal marker).
//   3. Relative path safety: forbids path traversal (..) and absolute paths.
//   4. Declarations are not permissions: an extension cannot self-grant permissions.
//   5. Manifest JSON is capped at 64KB (enforced in extension-installer validator).
//   6. Secret-scan: metadata keys/values matching credential patterns are rejected.

import { z } from "zod";
import { ExtensionCapabilitySchema, normalizeCapabilities } from "./capabilities.js";
import { RENDERABLE_KINDS, type SurfaceKind } from "@ai-desktop/ai-core";

/**
 * Surface contribution (PR33): an extension declares which of its tools may
 * produce a rich surface, with a pre-validated descriptor shape. The host
 * SurfaceService independently validates, hash-checks, permission-gates,
 * and renders — the declaration alone creates nothing.
 */
export const PluginSurfaceContributionSchema = z.object({
  toolName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-_]{1,64}$/, {
      message: "Surface tool name must match ^[a-z0-9-_]{1,64}$",
    }),
  surfaceId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/, {
      message: "Surface id must be lowercase alphanumeric with optional dot/dash/underscore/colon",
    }),
  kind: z.enum(RENDERABLE_KINDS as unknown as [SurfaceKind, ...SurfaceKind[]]),
  title: z.string().trim().min(1).max(200).optional(),
  version: z
    .string()
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
      { message: "Surface version must be valid SemVer (e.g. 1.0.0)" },
    )
    .default("1.0.0"),
});

export type PluginSurfaceContribution = z.infer<typeof PluginSurfaceContributionSchema>;

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MAX_MANIFEST_BYTES = 64 * 1024; // 64KB

const SECRET_PATTERN =
  /api[\-_ ]?key|access[\-_ ]?token|auth[\-_ ]?token|private[\-_ ]?key|password|secret|token/i;

/**
 * Validates that a path is strictly relative and does not traverse outside the package root.
 */
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") {
    return false;
  }
  const normalized = relPath.replace(/\\/g, "/").trim();
  // Reject absolute paths (POSIX / or Windows drive C:)
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  // Reject path traversal segments (.. or /../)
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return false;
  }
  return true;
}

export const SafeRelativePathSchema = z.string().trim().min(1).refine(isSafeRelativePath, {
  message:
    "Path must be a relative path and cannot contain path traversal (..) or absolute separators",
});

export const PluginToolContributionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-_]{1,64}$/, {
      message: "Tool name must match ^[a-z0-9-_]{1,64}$",
    }),
  description: z.string().trim().min(1).max(500),
  parameters: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  timeoutMs: z.number().int().positive().optional(),
  entry: SafeRelativePathSchema.optional(),
});

export type PluginToolContribution = z.infer<typeof PluginToolContributionSchema>;

export const ExtensionManifestSchema = z
  .object({
    id: z.string().trim().min(1).max(64).regex(EXTENSION_ID_PATTERN, {
      message: "Extension id must be a slug matching ^[a-z0-9][a-z0-9-]{0,63}$",
    }),
    name: z.string().trim().min(1).max(100),
    version: z
      .string()
      .regex(SEMVER_PATTERN, { message: "Version must be valid SemVer (e.g. 1.0.0)" }),
    displayName: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    publisher: z.string().trim().min(1).max(100).optional(),
    capabilities: z.array(ExtensionCapabilitySchema).min(1),
    contributes: z
      .object({
        tools: z.array(PluginToolContributionSchema).max(16).default([]),
        surfaces: z.array(PluginSurfaceContributionSchema).max(8).default([]),
      })
      .default({ tools: [], surfaces: [] }),
    minimumHostVersion: z
      .string()
      .regex(SEMVER_PATTERN, { message: "minimumHostVersion must be valid SemVer" })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.metadata) {
      for (const [key, value] of Object.entries(manifest.metadata)) {
        if (SECRET_PATTERN.test(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", key],
            message: `Metadata key "${key}" looks like a credential and is rejected`,
          });
        } else if (typeof value === "string" && SECRET_PATTERN.test(value)) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", key],
            message: `Metadata value for "${key}" looks like a credential and is rejected`,
          });
        }
      }
    }
  })
  .transform((manifest) => ({
    ...manifest,
    capabilities: normalizeCapabilities(manifest.capabilities),
  }));

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
