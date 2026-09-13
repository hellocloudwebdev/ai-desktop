// PR32: packages/plugins — Package Boundary Tests
//
// Static audit proving the extension domain package stays host-agnostic:
// no Electron, no Prisma, no provider/MCP SDKs, no process spawning, no
// wholesale environment access. Host-owned concerns (storage persistence,
// PermissionManager mediation, process execution) compose in apps/desktop.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PACKAGE_SRC = path.join(__dirname, "..");

function readPackageSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(PACKAGE_SRC);
  return files;
}

describe("packages/plugins: package boundary (PR32)", () => {
  it("imports no Electron/Prisma/SDK/child_process/docker", () => {
    const sources = readPackageSources();
    expect(sources.length).toBeGreaterThan(0);
    const forbidden = [
      'from "electron"',
      "from 'electron'",
      "@prisma/client",
      "@anthropic-ai/sdk",
      "@google/genai",
      "@modelcontextprotocol/sdk",
      "child_process",
      "node:child_process",
      "dockerode",
      "node:docker",
      "BrowserWindow",
      "ipcMain",
      "ipcRenderer",
    ];
    for (const source of sources) {
      for (const marker of forbidden) {
        expect(source.includes(marker), `forbidden marker: ${marker}`).toBe(false);
      }
    }
  });

  it("never imports @ai-desktop/storage, @ai-desktop/permissions, or @ai-desktop/desktop packages", () => {
    const sources = readPackageSources();
    const forbiddenPackages = [
      "@ai-desktop/storage",
      "@ai-desktop/permissions",
      "@ai-desktop/execution",
      "@ai-desktop/memory",
      "@ai-desktop/providers",
      "@ai-desktop/mcp",
      "@ai-desktop/skills",
      "@ai-desktop/agent-runtime",
    ];
    for (const source of sources) {
      for (const marker of forbiddenPackages) {
        expect(source.includes(marker), `forbidden package import: ${marker}`).toBe(false);
      }
    }
  });

  it("never spawns processes or reads the ambient environment wholesale", () => {
    const sources = readPackageSources();
    const forbidden = ["spawn(", "execSync(", "execFileSync(", "process.env[", "process.env."];
    for (const source of sources) {
      for (const marker of forbidden) {
        expect(source.includes(marker), `forbidden host access: ${marker}`).toBe(false);
      }
    }
  });
});
