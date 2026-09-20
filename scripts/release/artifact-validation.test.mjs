// scripts/release/artifact-validation.test.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "artifact-validation.mjs");

function runScript(args) {
  return execFileSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("release: artifact-validation.mjs", () => {
  it("fails when directory does not exist", () => {
    expect(() => runScript(["/non/existent/path/9999"])).toThrow();
  });

  it("fails when no installers exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "art-empty-"));
    try {
      expect(() => runScript([tmp])).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails when installer is undersized (< 20MB)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "art-small-"));
    try {
      const installer = path.join(tmp, "AI-Desktop-1.0.0-win-x64.exe");
      fs.writeFileSync(installer, "tiny binary");
      const hash = createHash("sha256").update("tiny binary").digest("hex");
      fs.writeFileSync(`${installer}.sha256`, `${hash}  AI-Desktop-1.0.0-win-x64.exe\n`);
      fs.writeFileSync(
        path.join(tmp, "latest.yml"),
        "version: 1.0.0\npath: AI-Desktop-1.0.0-win-x64.exe\n",
      );

      expect(() => runScript([tmp])).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes when installer > 20MB, sha256 verifies, and update manifest is valid", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "art-pass-"));
    try {
      const installer = path.join(tmp, "AI-Desktop-1.0.0-win-x64.exe");
      // 21 MB sparse/buffer file
      const size = 21 * 1024 * 1024;
      const fd = fs.openSync(installer, "w");
      fs.writeSync(fd, Buffer.alloc(1024, 0x41), 0, 1024, 0);
      fs.writeSync(fd, Buffer.alloc(1024, 0x42), 0, 1024, size - 1024);
      fs.closeSync(fd);

      const content = fs.readFileSync(installer);
      const hash = createHash("sha256").update(content).digest("hex");
      fs.writeFileSync(`${installer}.sha256`, `${hash}  AI-Desktop-1.0.0-win-x64.exe\n`);
      fs.writeFileSync(
        path.join(tmp, "latest.yml"),
        "version: 1.0.0\npath: AI-Desktop-1.0.0-win-x64.exe\n",
      );

      const stdout = runScript([tmp, "--app-version", "1.0.0"]);
      expect(stdout).toContain("PASS  artifacts-dir-exists");
      expect(stdout).toContain("PASS  installer-present");
      expect(stdout).toContain("PASS  sha256-verified");
      expect(stdout).toContain("PASS  update-manifest");
      expect(stdout).toContain("PASS  size-sanity");
      expect(stdout).toContain("All artifact checks passed.");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
