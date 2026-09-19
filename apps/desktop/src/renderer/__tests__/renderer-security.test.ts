// PR46: renderer — Source-Security Suite (static, no DOM)
//
// Pins the renderer trust boundary from the unprivileged side:
//   a. No electron/node/child_process/prisma imports (Process/Storage
//      isolation — the renderer talks to main ONLY via window.api).
//   b. No window.api raw escape (no window.require/electron/ipcRenderer,
//      no eval/new Function, no dangerouslySetInnerHTML).
//   c. No secrets in localStorage/sessionStorage (versioned workspace UI
//      state only; tokens live main-side in the OS SecretStore).
//   d. No token storage (no refresh/access-token keys or bearers).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RENDERER_SRC = path.join(__dirname, "..");

interface SourceFile {
  readonly relativePath: string;
  readonly content: string;
}

function collectSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(tsx?|jsx?|mjs|cjs|css)$/.test(entry.name)) {
        out.push({
          relativePath: path.relative(RENDERER_SRC, full).split(path.sep).join("/"),
          content: fs.readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(RENDERER_SRC);
  return out;
}

const SOURCES = collectSources();

describe("renderer-security: no privileged imports", () => {
  it("collects renderer sources (sanity)", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
  });

  it("imports no electron runtime", () => {
    const offenders = SOURCES.filter((file) =>
      /from\s+["']electron["']|require\s*\(\s*["']electron["']\s*\)/.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it("imports no node:*, child_process, fs, or prisma", () => {
    const offenders = SOURCES.filter(
      (file) =>
        /from\s+["']node:/.test(file.content) ||
        /require\s*\(\s*["']node:/.test(file.content) ||
        /child_process/.test(file.content) ||
        /from\s+["']fs["']/.test(file.content) ||
        /@prisma\/client/.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it("spawns no processes and uses no dynamic code execution", () => {
    const offenders = SOURCES.filter(
      (file) => /\beval\s*\(/.test(file.content) || /\bnew\s+Function\s*\(/.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });
});

describe("renderer-security: no window.api raw escape", () => {
  it("never touches raw bridge objects", () => {
    const offenders = SOURCES.filter(
      (file) =>
        /window\.require/.test(file.content) ||
        /window\.electron/.test(file.content) ||
        /window\.ipcRenderer/.test(file.content) ||
        /(^|[^\w.])ipcRenderer\s*\./.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it("renders no raw HTML (no dangerouslySetInnerHTML / innerHTML writes)", () => {
    const offenders = SOURCES.filter(
      (file) =>
        /dangerouslySetInnerHTML/.test(file.content) || /\.innerHTML\s*=/.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it("App owns renderer state over window.api only", () => {
    const app = SOURCES.find((file) => file.relativePath === "App.tsx");
    expect(app).toBeDefined();
    expect(app?.content).toContain("window.api");
  });
});

describe("renderer-security: no secrets in web storage", () => {
  const SECRET_KEY_PATTERN = /token|secret|apikey|api_key|password|refresh|credential|auth/i;

  it("writes no secret-shaped keys to localStorage/sessionStorage", () => {
    const offenders: string[] = [];
    const setter = /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*["']([^"']+)["']/g;
    for (const file of SOURCES) {
      let match: RegExpExecArray | null;
      while ((match = setter.exec(file.content)) !== null) {
        if (SECRET_KEY_PATTERN.test(match[1])) {
          offenders.push(`${file.relativePath}: key "${match[1]}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("stores no refresh/access tokens or bearer credentials", () => {
    const offenders = SOURCES.filter(
      (file) =>
        /refresh[_-]?token/i.test(file.content) ||
        /access[_-]?token/i.test(file.content) ||
        /Authorization["']?\s*:\s*["']Bearer/i.test(file.content),
    ).map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });
});
