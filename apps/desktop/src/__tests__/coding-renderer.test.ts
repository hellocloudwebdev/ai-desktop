// PR30.14: apps/desktop — Renderer Coding Boundary Tests
//
// Static proofs: the renderer coding surface uses the typed preload bridge
// only — no Node/Electron/filesystem/process APIs in renderer code.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

function readRendererSources(): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Test harnesses legitimately use node:fs; the boundary applies to
        // shipped renderer code (PR31: __tests__ added under renderer/).
        if (entry.name === "__tests__") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        out.push({ file: full, content: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(RENDERER_DIR);
  return out;
}

describe("apps/desktop: Renderer coding boundary (PR30.14)", () => {
  it("renderer imports no Node/Electron/filesystem/process APIs", () => {
    const sources = readRendererSources();
    expect(sources.length).toBeGreaterThan(0);
    const forbidden = [
      'from "electron"',
      "from 'electron'",
      'from "node:',
      "from 'node:",
      'require("fs")',
      "require('fs')",
      'require("child_process")',
      "child_process",
      "window.require",
    ];
    for (const { file, content } of sources) {
      for (const marker of forbidden) {
        expect(content.includes(marker), `${path.basename(file)} contains ${marker}`).toBe(false);
      }
    }
  });

  it("coding surface drives tasks through window.api commands only", () => {
    const appPath = path.join(RENDERER_DIR, "App.tsx");
    const content = fs.readFileSync(appPath, "utf8");
    expect(content).toContain("startCodingTask");
    expect(content).toContain("cancelCodingTask");
    expect(content).toContain("getCodingTask");
    expect(content).toContain("listCodingTasks");
    expect(content).toContain("window.api.commands");
  });
});
