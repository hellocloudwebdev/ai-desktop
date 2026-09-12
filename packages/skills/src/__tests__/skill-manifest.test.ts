import { describe, expect, it } from "vitest";
import {
  isSafeRelativePath,
  SkillManifestSchema,
  type SkillManifest,
} from "../core/skill-manifest.js";

describe("packages/skills: SkillManifest & Path Security (PR26.2, PR26.3)", () => {
  it("accepts a valid canonical skill manifest", () => {
    const validManifest: SkillManifest = {
      id: "code-review" as unknown as import("@ai-desktop/ai-core").SkillId,
      name: "Code Reviewer",
      version: "1.0.0",
      description: "Automated code reviewer for TypeScript projects",
      capabilities: ["filesystem", "execution"],
      entry: "SKILL.md",
      references: ["references/guidelines.md"],
      examples: ["examples/sample.ts"],
      scripts: [
        {
          name: "review",
          path: "scripts/review.js",
          command: "node",
          description: "Runs code review analysis",
          parameters: { type: "object", properties: { target: { type: "string" } } },
          checksum: "a".repeat(64),
        },
      ],
    };

    const parsed = SkillManifestSchema.parse(validManifest);
    expect(parsed.id).toBe("code-review");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0].name).toBe("review");
  });

  it("rejects invalid semver", () => {
    const invalidManifest = {
      id: "my-skill",
      name: "My Skill",
      version: "v1.0", // Invalid SemVer
      description: "Desc",
    };

    expect(() => SkillManifestSchema.parse(invalidManifest)).toThrow(/valid SemVer/);
  });

  it("SECURITY: path traversal checks reject .. and absolute paths", () => {
    // 1. Path traversal segments
    expect(isSafeRelativePath("../script.sh")).toBe(false);
    expect(isSafeRelativePath("../../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("scripts/../../secret")).toBe(false);
    expect(isSafeRelativePath("./script.js")).toBe(false);

    // 2. Absolute paths
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\system32")).toBe(false);
    expect(isSafeRelativePath("D:/secret")).toBe(false);

    // 3. Safe relative paths
    expect(isSafeRelativePath("SKILL.md")).toBe(true);
    expect(isSafeRelativePath("references/guide.md")).toBe(true);
    expect(isSafeRelativePath("scripts/analyze.py")).toBe(true);
  });

  it("SECURITY: rejects path traversal in manifest fields", () => {
    const maliciousManifest = {
      id: "exploit-skill",
      name: "Exploit",
      version: "1.0.0",
      description: "Attempts path escape",
      entry: "../../etc/passwd", // Traversal!
    };

    expect(() => SkillManifestSchema.parse(maliciousManifest)).toThrow(
      /Path must be a relative path/,
    );
  });

  it("SECURITY: rejects path traversal in script paths", () => {
    const maliciousManifest = {
      id: "exploit-skill",
      name: "Exploit",
      version: "1.0.0",
      description: "Attempts script escape",
      scripts: [
        {
          name: "pwn",
          path: "../../../evil.sh",
          command: "bash",
          description: "Evil",
          checksum: "b".repeat(64),
        },
      ],
    };

    expect(() => SkillManifestSchema.parse(maliciousManifest)).toThrow(
      /Path must be a relative path/,
    );
  });
});
