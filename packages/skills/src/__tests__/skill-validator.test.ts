import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { computeFileChecksum, validateSkillPackage } from "../core/skill-validator.js";

function createTempSkillDir(options?: {
  alterScript?: boolean;
  corruptManifest?: boolean;
  missingEntry?: boolean;
}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-skill-val-"));

  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });

  const scriptContent = 'console.log("Hello from code-review script");\n';
  const scriptPath = path.join(dir, "scripts", "review.js");
  fs.writeFileSync(scriptPath, scriptContent);

  const checksum = computeFileChecksum(scriptPath);

  if (!options?.missingEntry) {
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# Code Review Skill\n");
  }
  fs.writeFileSync(path.join(dir, "references", "guide.md"), "# Guide\n");

  const manifest = {
    id: "code-review",
    name: "Code Review",
    version: "1.0.0",
    description: "Reviews code",
    capabilities: ["execution"],
    entry: "SKILL.md",
    references: ["references/guide.md"],
    scripts: [
      {
        name: "review",
        path: "scripts/review.js",
        command: "node",
        description: "Runs review",
        checksum: options?.alterScript ? "0".repeat(64) : checksum,
      },
    ],
  };

  if (!options?.corruptManifest) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } else {
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ invalid JSON ");
  }

  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("packages/skills: Skill Package Validator (PR26.4)", () => {
  it("validates a healthy skill package and verifies script checksum", () => {
    const { dir, cleanup } = createTempSkillDir();
    try {
      const res = validateSkillPackage(dir);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.manifest.id).toBe("code-review");
        expect(res.value.computedChecksums.has("review")).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("fails validation when manifest.json has JSON syntax errors", () => {
    const { dir, cleanup } = createTempSkillDir({ corruptManifest: true });
    try {
      const res = validateSkillPackage(dir);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Failed to parse manifest.json");
      }
    } finally {
      cleanup();
    }
  });

  it("fails validation when entry point file (SKILL.md) is missing", () => {
    const { dir, cleanup } = createTempSkillDir({ missingEntry: true });
    try {
      const res = validateSkillPackage(dir);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain('entry point file "SKILL.md" does not exist');
      }
    } finally {
      cleanup();
    }
  });

  it("SECURITY: fails validation on script checksum mismatch", () => {
    const { dir, cleanup } = createTempSkillDir({ alterScript: true });
    try {
      const res = validateSkillPackage(dir);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Checksum mismatch");
      }
    } finally {
      cleanup();
    }
  });
});
