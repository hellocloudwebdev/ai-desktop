// PR26: packages/skills — Public API Surface
//
// Invariants:
//   1. Skill is an installable package, not an agent (no agent loop).
//   2. Scripts execute exclusively through ExecutionManager.
//   3. Checksums are verified immediately before execution.
//   4. Reference content is loaded on demand.

export type {
  SkillManifest,
  SkillScriptDefinition,
  SkillState,
  SkillPackageInfo,
} from "./core/skill-manifest.js";
export {
  SkillManifestSchema,
  SkillScriptDefinitionSchema,
  SafeRelativePathSchema,
  isSafeRelativePath,
} from "./core/skill-manifest.js";

export type { ValidatedSkillPackage } from "./core/skill-validator.js";
export {
  validateSkillPackage,
  computeFileChecksum,
  computeBufferChecksum,
} from "./core/skill-validator.js";

export type { SkillInstallerOptions } from "./core/skill-installer.js";
export { SkillInstaller } from "./core/skill-installer.js";

export type { SkillManagerOptions } from "./core/skill-manager.js";
export { SkillManager, MAX_REFERENCE_BYTES } from "./core/skill-manager.js";

export type { ExecuteSkillToolOptions } from "./core/skill-tool-executor.js";
export { SkillToolExecutor } from "./core/skill-tool-executor.js";

export {
  SkillToolRegistry,
  toCanonicalSkillToolId,
  parseCanonicalSkillToolId,
} from "./core/tool-registry.js";
