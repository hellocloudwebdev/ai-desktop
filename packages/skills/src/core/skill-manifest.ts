// PR26.2 & PR26.3: packages/skills — Skill Manifest & Lifecycle Contract
//
// Invariants:
//   1. Skill is an installable package, NOT an agent (does not own an agent loop).
//   2. SkillId is reused from @ai-desktop/ai-core.
//   3. Lifecycle states: Installed -> Enabled -> Active.
//   4. Relative path safety: forbids path traversal (..) and absolute paths.
//   5. Declarations are not permissions: a Skill cannot self-grant permissions.

import { z } from "zod";
import { SkillIdSchema, type SkillId } from "@ai-desktop/ai-core";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

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

export const SkillScriptDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(64),
  path: SafeRelativePathSchema,
  command: z.string().trim().min(1),
  description: z.string().trim().min(1),
  parameters: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, {
    message: "Checksum must be a 64-character SHA-256 hexadecimal string",
  }),
  timeoutMs: z.number().int().positive().optional(),
  requiredPermissions: z.array(z.string()).optional(),
});

export type SkillScriptDefinition = z.infer<typeof SkillScriptDefinitionSchema>;

export const SkillManifestSchema = z.object({
  id: SkillIdSchema,
  name: z.string().trim().min(1).max(100),
  version: z
    .string()
    .regex(SEMVER_PATTERN, { message: "Version must be valid SemVer (e.g. 1.0.0)" }),
  description: z.string().trim().min(1).max(500),
  capabilities: z.array(z.string()).default([]),
  entry: SafeRelativePathSchema.default("SKILL.md"),
  references: z.array(SafeRelativePathSchema).default([]),
  examples: z.array(SafeRelativePathSchema).default([]),
  scripts: z.array(SkillScriptDefinitionSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export type SkillState = "installed" | "enabled" | "active" | "failed";

export interface SkillPackageInfo {
  readonly id: SkillId;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly state: SkillState;
  readonly installPath: string;
  readonly installedAt: number;
  readonly updatedAt: number;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly error?: string;
  readonly scriptCount: number;
}
