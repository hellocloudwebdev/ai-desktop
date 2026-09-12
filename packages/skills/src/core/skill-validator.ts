// PR26.4: packages/skills — Skill Package Validator & Integrity Verification
//
// Invariants:
//   1. Validates manifest.json conforms to SkillManifestSchema.
//   2. Ensures all declared paths are safe relative paths within the skill package.
//   3. Validates that declared files exist on the filesystem.
//   4. Computes SHA-256 checksums of executable scripts and compares against manifest.
//   5. Validation occurs before installation can become active.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Result, ok, err, ValidationError } from "@ai-desktop/shared";
import { isSafeRelativePath, SkillManifestSchema, type SkillManifest } from "./skill-manifest.js";

export interface ValidatedSkillPackage {
  readonly manifest: SkillManifest;
  readonly packageDir: string;
  readonly computedChecksums: ReadonlyMap<string, string>; // scriptName -> sha256
}

export function computeFileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function computeBufferChecksum(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validateSkillPackage(
  packageDir: string,
): Result<ValidatedSkillPackage, ValidationError> {
  // 1. Check directory exists
  if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) {
    return err(new ValidationError(`Skill package directory does not exist: "${packageDir}"`));
  }

  // 2. Read and parse manifest.json
  const manifestPath = path.join(packageDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return err(
      new ValidationError(`Missing required manifest.json in skill package: "${packageDir}"`),
    );
  }

  let rawJson: unknown;
  try {
    const rawStr = fs.readFileSync(manifestPath, "utf8");
    rawJson = JSON.parse(rawStr);
  } catch (parseErr: unknown) {
    return err(
      new ValidationError(
        `Failed to parse manifest.json as JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      ),
    );
  }

  const parsedManifestResult = SkillManifestSchema.safeParse(rawJson);
  if (!parsedManifestResult.success) {
    const issues = parsedManifestResult.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return err(new ValidationError(`Invalid skill manifest: ${issues}`));
  }
  const manifest = parsedManifestResult.data;

  // 3. Check entry point file exists
  const entryPath = path.join(packageDir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    return err(
      new ValidationError(`Skill entry point file "${manifest.entry}" does not exist in package`),
    );
  }

  // 4. Verify all declared references and examples exist and have safe paths
  for (const ref of [...manifest.references, ...manifest.examples]) {
    if (!isSafeRelativePath(ref)) {
      return err(new ValidationError(`Path traversal or unsafe path detected: "${ref}"`));
    }
    const fullPath = path.join(packageDir, ref);
    if (!fs.existsSync(fullPath)) {
      return err(new ValidationError(`Declared reference file "${ref}" does not exist in package`));
    }
  }

  // 5. Verify all scripts exist, have safe paths, and verify checksums
  const computedChecksums = new Map<string, string>();

  for (const script of manifest.scripts) {
    if (!isSafeRelativePath(script.path)) {
      return err(
        new ValidationError(`Unsafe script path detected for "${script.name}": "${script.path}"`),
      );
    }
    const fullScriptPath = path.join(packageDir, script.path);
    if (!fs.existsSync(fullScriptPath)) {
      return err(
        new ValidationError(
          `Script file "${script.path}" for tool "${script.name}" does not exist`,
        ),
      );
    }

    const actualChecksum = computeFileChecksum(fullScriptPath);
    computedChecksums.set(script.name, actualChecksum);

    if (actualChecksum.toLowerCase() !== script.checksum.toLowerCase()) {
      return err(
        new ValidationError(
          `Checksum mismatch for script "${script.name}": declared "${script.checksum}", computed "${actualChecksum}"`,
        ),
      );
    }
  }

  return ok({
    manifest,
    packageDir,
    computedChecksums,
  });
}
