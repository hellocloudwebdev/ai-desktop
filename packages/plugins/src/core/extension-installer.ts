// PR32: packages/plugins — Extension Installer
//
// Invariants:
//   1. Validates BEFORE persisting: manifest.json parse + schema, manifest JSON
//      size cap 64KB, declared entry file existence, secret-scan via schema.
//   2. No code execution, no npm, no downloads during install.

import fs from "node:fs";
import path from "node:path";
import { ValidationError, type Result, ok, err } from "@ai-desktop/shared";
import {
  ExtensionManifestSchema,
  MAX_MANIFEST_BYTES,
  isSafeRelativePath,
  type ExtensionManifest,
} from "../core/manifest.js";
import { computeExtensionDefinitionHash } from "../core/extension-trust.js";
import type { ExtensionRepository } from "./extension-manager.js";
import type { ExtensionProjectBindingRepository } from "./extension-manager.js";

export interface ValidatedExtensionPackage {
  readonly manifest: ExtensionManifest;
  readonly packageDir: string;
  readonly manifestHash: string;
}

export function validateExtensionPackage(
  sourceDir: string,
): Result<ValidatedExtensionPackage, ValidationError> {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return err(new ValidationError(`Extension package directory does not exist: "${sourceDir}"`));
  }

  const manifestPath = path.join(sourceDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return err(
      new ValidationError(`Missing required manifest.json in extension package: "${sourceDir}"`),
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(manifestPath);
  } catch (statErr: unknown) {
    return err(
      new ValidationError(
        `Cannot stat manifest.json: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
      ),
    );
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    return err(
      new ValidationError(
        `manifest.json (${stat.size} bytes) exceeds the ${MAX_MANIFEST_BYTES} byte cap`,
      ),
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

  const parsed = ExtensionManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return err(new ValidationError(`Invalid extension manifest: ${issues}`));
  }
  const manifest = parsed.data;

  // Declared tool entry files must exist (when declared) and be path-safe.
  for (const tool of manifest.contributes.tools) {
    if (tool.entry !== undefined) {
      if (!isSafeRelativePath(tool.entry)) {
        return err(
          new ValidationError(
            `Unsafe entry path detected for tool "${tool.name}": "${tool.entry}"`,
          ),
        );
      }
      const fullEntry = path.join(sourceDir, tool.entry);
      if (!fs.existsSync(fullEntry)) {
        return err(
          new ValidationError(
            `Declared entry file "${tool.entry}" for tool "${tool.name}" does not exist`,
          ),
        );
      }
    }
  }

  const manifestHash = computeExtensionDefinitionHash({
    id: manifest.id,
    version: manifest.version,
    capabilities: manifest.capabilities,
    contributes: manifest.contributes,
  });

  return ok({ manifest, packageDir: sourceDir, manifestHash });
}

export interface ExtensionInstallerOptions {
  readonly repository: ExtensionRepository;
  readonly bindingRepository?: ExtensionProjectBindingRepository;
}

export interface InstallExtensionResult {
  readonly extensionId: string;
  readonly manifestHash: string;
}

export class ExtensionInstaller {
  private readonly _repository: ExtensionRepository;
  private readonly _bindings?: ExtensionProjectBindingRepository;

  constructor(options: ExtensionInstallerOptions) {
    this._repository = options.repository;
    this._bindings = options.bindingRepository;
  }

  /**
   * Validates an extension package directory and persists its record.
   * Performs no code execution, no npm installs, no downloads.
   */
  async install(
    sourceDir: string,
    options?: { projectId?: string },
  ): Promise<Result<InstallExtensionResult, ValidationError>> {
    const validated = validateExtensionPackage(sourceDir);
    if (!validated.ok) {
      return err(validated.error);
    }
    const { manifest, manifestHash } = validated.value;
    const nowMs = Date.now();

    try {
      await this._repository.save({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        capabilities: [...manifest.capabilities],
        manifestHash,
        lifecycle: "installed",
        trust: "untrusted",
        installPath: sourceDir,
        installedAt: nowMs,
        updatedAt: nowMs,
      });
    } catch (persistErr: unknown) {
      return err(
        new ValidationError(
          `Failed to persist extension "${manifest.id}": ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        ),
      );
    }

    if (options?.projectId !== undefined) {
      await this._bindings?.setBinding(manifest.id, options.projectId, true);
    }

    return ok({ extensionId: manifest.id, manifestHash });
  }
}
