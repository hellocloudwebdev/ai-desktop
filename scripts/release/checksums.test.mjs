// scripts/release/checksums.test.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "checksums.mjs");

function runScript(args) {
  return execFileSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("release: checksums.mjs", () => {
  it("generates sha256 sidecars for binary artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chk-"));
    try {
      const installer = path.join(tmp, "app-1.0.0-win-x64.exe");
      const content = Buffer.from("mock installer binary data");
      fs.writeFileSync(installer, content);

      const stdout = runScript([tmp]);
      const expectedHash = createHash("sha256").update(content).digest("hex");
      expect(stdout).toContain(expectedHash);
      expect(stdout).toContain("app-1.0.0-win-x64.exe");

      const sidecar = `${installer}.sha256`;
      expect(fs.existsSync(sidecar)).toBe(true);
      const sidecarContent = fs.readFileSync(sidecar, "utf8");
      expect(sidecarContent).toBe(`${expectedHash}  app-1.0.0-win-x64.exe\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips .yml, .yaml, and .sha256 files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chk-skip-"));
    try {
      fs.writeFileSync(path.join(tmp, "app.exe"), "bin");
      fs.writeFileSync(path.join(tmp, "latest.yml"), "version: 1.0.0");
      fs.writeFileSync(path.join(tmp, "meta.yaml"), "foo: bar");

      runScript([tmp]);

      expect(fs.existsSync(path.join(tmp, "app.exe.sha256"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "latest.yml.sha256"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, "meta.yaml.sha256"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits with error on missing directory", () => {
    expect(() => runScript(["/non/existent/dir/12345"])).toThrow();
  });
});
