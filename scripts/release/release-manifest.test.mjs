// scripts/release/release-manifest.test.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "release-manifest.mjs");

function runScript(args) {
  return execFileSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("release: release-manifest.mjs", () => {
  it("builds a valid JSON manifest for release artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rel-man-"));
    try {
      const installer = path.join(tmp, "AI-Desktop-1.0.0-win-x64.exe");
      const content = Buffer.from("installer binary content");
      fs.writeFileSync(installer, content);
      const hash = createHash("sha256").update(content).digest("hex");
      fs.writeFileSync(`${installer}.sha256`, `${hash}  AI-Desktop-1.0.0-win-x64.exe\n`);

      const outPath = path.join(tmp, "manifest.json");
      const stdout = runScript([
        "--dir",
        tmp,
        "--version",
        "1.0.0",
        "--channel",
        "stable",
        "--repo",
        "hellocloudwebdev/ai-desktop",
        "--out",
        outPath,
      ]);

      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].version).toBe("1.0.0");
      expect(parsed[0].channel).toBe("stable");
      expect(parsed[0].repository).toBe("hellocloudwebdev/ai-desktop");
      expect(parsed[0].platform).toBe("win");
      expect(parsed[0].arch).toBe("x64");
      expect(parsed[0].artifact).toBe("AI-Desktop-1.0.0-win-x64.exe");
      expect(parsed[0].sha256).toBe(hash);
      expect(parsed[0].size).toBe(content.length);
      expect(typeof parsed[0].releaseDate).toBe("string");

      expect(fs.existsSync(outPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(outPath, "utf8"))).toEqual(parsed);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects invalid channels", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rel-man-bad-"));
    try {
      expect(() =>
        runScript([
          "--dir",
          tmp,
          "--version",
          "1.0.0",
          "--channel",
          "canary",
          "--repo",
          "hellocloudwebdev/ai-desktop",
        ]),
      ).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
