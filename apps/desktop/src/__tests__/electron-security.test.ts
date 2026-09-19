// PR46: apps/desktop — Electron + Main Window Security Suite
//
// Pins the audited production posture (Electron 44, verified compatible):
//   a. Secure webPreferences (contextIsolation/sandbox/webSecurity) —
//      verified present, never flipped; regression-pinned here.
//   b. Deny-by-default window controls: window-open always denied,
//      top-level navigation allowlisted, webviews denied.
//   c. External-URL policy: https-only, no credentials, never auto-opened.
//   d. No Node/Electron in the renderer (source assertions).
//   e. Preload bridge stays narrow (typed methods only, no raw primitives).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  configureWindowSecurity,
  getSecureWebPreferences,
  isAllowedExternalUrl,
  isAllowedNavigationUrl,
} from "../main/index.js";
import { createDesktopApi } from "../preload/index.js";

const DESKTOP_ROOT = path.join(__dirname, "..");
const MAIN_INDEX_SRC = fs.readFileSync(path.join(DESKTOP_ROOT, "main", "index.ts"), "utf8");
const PRELOAD_SRC = fs.readFileSync(path.join(DESKTOP_ROOT, "preload", "index.ts"), "utf8");

/** Code under test: comments document the audit ("zero X call sites") so
 *  presence proofs strip comments first and assert on real code only. */
function stripTestComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

const MAIN_CODE = stripTestComments(MAIN_INDEX_SRC);
const PRELOAD_CODE = stripTestComments(PRELOAD_SRC);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function makeStubWindow() {
  const handlers: Record<string, (...args: never[]) => void> = {};
  let openHandler: ((details: { url: string }) => { action: "deny" | "allow" }) | null = null;
  const webContents = {
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "deny" | "allow" },
    ): void {
      openHandler = handler;
    },
    on(event: string, listener: (...args: never[]) => void): void {
      handlers[event] = listener;
    },
    removeListener(event: string): void {
      delete handlers[event];
    },
  };
  return {
    webContents,
    handlers,
    invokeOpen: (url: string) => openHandler?.({ url }),
  };
}

describe("electron-security: secure webPreferences (PR12 posture, PR46 pinned)", () => {
  it("enforces contextIsolation/sandbox/webSecurity with no Node integration", () => {
    const prefs = getSecureWebPreferences("/dummy/preload.js");
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.preload).toBe("/dummy/preload.js");
  });

  it("matches the pinned Electron 44 shell (no incompatible option flips)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(DESKTOP_ROOT, "..", "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const electronVersion = pkg.devDependencies?.["electron"] ?? "";
    expect(electronVersion.startsWith("44")).toBe(true);
    // The preferences above are the Electron-44-compatible secure set:
    // contextIsolation + sandbox + webSecurity are stable since Electron 20+;
    // no experimental flag (e.g. nodeIntegrationInWorker, spellcheck touching
    // webSecurity) is introduced here.
    expect(MAIN_INDEX_SRC).toContain("contextIsolation: true");
    expect(MAIN_INDEX_SRC).toContain("nodeIntegration: false");
    expect(MAIN_INDEX_SRC).toContain("sandbox: true");
    expect(MAIN_INDEX_SRC).toContain("webSecurity: true");
    expect(MAIN_INDEX_SRC).not.toContain("nodeIntegration: true");
  });

  it("wires navigation lockdown in main (source presence proof)", () => {
    expect(MAIN_INDEX_SRC).toContain("setWindowOpenHandler");
    expect(MAIN_INDEX_SRC).toContain("will-navigate");
    expect(MAIN_INDEX_SRC).toContain("will-attach-webview");
    expect(MAIN_INDEX_SRC).toContain("configureWindowSecurity");
    expect(MAIN_INDEX_SRC).toContain("isAllowedNavigationUrl");
    // Policy: main never auto-opens external URLs and registers no custom
    // protocol handlers (allowlist = none registered; file:/dev-origin only).
    // Comment-aware: audit comments name these APIs, so assert on code.
    expect(MAIN_CODE).not.toContain("shell.openExternal");
    expect(MAIN_CODE).not.toContain("registerSchemesAsPrivileged");
    expect(MAIN_CODE).not.toContain("registerStringProtocol");
  });
});

describe("electron-security: navigation allowlist", () => {
  const dev = "http://localhost:5173/";
  const bundle = "file:///app/dist/index.html";

  it("allows the local bundle targets only", () => {
    expect(isAllowedNavigationUrl("about:blank")).toBe(true);
    // file: is allowlisted ONLY for the exact bundle URL (local-file
    // exfiltration via crafted file: links stays denied).
    expect(isAllowedNavigationUrl(bundle, undefined, [bundle])).toBe(true);
    expect(isAllowedNavigationUrl(bundle)).toBe(false);
    expect(isAllowedNavigationUrl("file:///etc/passwd", undefined, [bundle])).toBe(false);
    expect(isAllowedNavigationUrl(`${dev}`, dev)).toBe(true);
    expect(isAllowedNavigationUrl(`${dev}index.html`, dev)).toBe(true);
  });

  it("denies remote and dangerous schemes even in dev", () => {
    for (const url of [
      "https://example.com/",
      "http://example.com/",
      "http://localhost:5173.evil.com/",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "blob:https://example.com/uuid",
      "file:///etc/passwd",
      "not-a-url",
      "",
    ]) {
      expect(isAllowedNavigationUrl(url, dev), url).toBe(false);
    }
    expect(isAllowedNavigationUrl("https://example.com/")).toBe(false);
  });
});

describe("electron-security: window-open handler (always deny)", () => {
  it("denies every new-window request and reports the violation", () => {
    const stub = makeStubWindow();
    const violations: Array<{ kind: string; url: string }> = [];
    const cleanup = configureWindowSecurity(stub as never, {
      devServerUrl: "http://localhost:5173/",
      onViolation: (violation) => {
        violations.push({ kind: violation.kind, url: violation.url });
      },
    });
    expect(stub.invokeOpen("https://example.com/")).toEqual({ action: "deny" });
    expect(stub.invokeOpen("about:blank")).toEqual({ action: "deny" });
    expect(violations.map((entry) => entry.kind)).toEqual(["window-open", "window-open"]);
    cleanup();
  });

  it("blocks disallowed will-navigate and permits the dev origin", () => {
    const stub = makeStubWindow();
    const violations: string[] = [];
    configureWindowSecurity(stub as never, {
      devServerUrl: "http://localhost:5173/",
      onViolation: (violation) => {
        violations.push(`${violation.kind}:${violation.url}`);
      },
    });
    const navigate = stub.handlers["will-navigate"];
    expect(navigate).toBeDefined();
    let prevented = false;
    navigate(
      {
        preventDefault: () => {
          prevented = true;
        },
      } as never,
      "https://evil.example/" as never,
    );
    expect(prevented).toBe(true);
    prevented = false;
    navigate(
      {
        preventDefault: () => {
          prevented = true;
        },
      } as never,
      "http://localhost:5173/index.html" as never,
    );
    expect(prevented).toBe(false);
    expect(violations).toEqual(["navigation:https://evil.example/"]);
  });

  it("denies webview attachment", () => {
    const stub = makeStubWindow();
    const violations: string[] = [];
    configureWindowSecurity(stub as never, {
      onViolation: (violation) => {
        violations.push(violation.kind);
      },
    });
    const attach = stub.handlers["will-attach-webview"];
    expect(attach).toBeDefined();
    let prevented = false;
    attach({
      preventDefault: () => {
        prevented = true;
      },
    } as never);
    expect(prevented).toBe(true);
    expect(violations).toEqual(["webview"]);
  });
});

describe("electron-security: external-URL policy (explicit opens only)", () => {
  it("allows https without credentials and denies the rest", () => {
    expect(isAllowedExternalUrl("https://example.com/docs")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com/")).toBe(false);
    expect(isAllowedExternalUrl("https://user:pass@example.com/")).toBe(false);
    expect(isAllowedExternalUrl("data:text/plain,hi")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not-a-url")).toBe(false);
  });
});

describe("electron-security: preload bridge stays narrow", () => {
  it("exposes typed methods only (no raw primitives)", () => {
    const api = createDesktopApi();
    const keys = Object.keys(api);
    for (const forbidden of [
      "ipcRenderer",
      "ipcMain",
      "BrowserWindow",
      "shell",
      "app",
      "process",
      "fs",
      "child_process",
      "electron",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(typeof api.commands.sendChatMessage).toBe("function");
    expect(typeof api.events.subscribeToConversation).toBe("function");
  });

  it("preload source has no raw bridge surface", () => {
    // Comment-aware: the audit header names the forbidden APIs explicitly.
    for (const marker of ["shell", "child_process", "node:fs", "node:child_process"]) {
      expect(PRELOAD_CODE, marker).not.toContain(marker);
    }
    expect(PRELOAD_CODE).not.toMatch(/exposeInMainWorld\s*\(\s*["']electron["']/);
    expect(PRELOAD_CODE).not.toMatch(/exposeInMainWorld\s*\(\s*["']ipcRenderer["']/);
  });
});

describe("electron-security: renderer carries no Node/Electron", () => {
  it("renderer sources import no electron/node-fs/child_process/prisma", () => {
    const rendererDir = path.join(DESKTOP_ROOT, "renderer");
    const files = walkFiles(rendererDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (
        /from\s+["']electron["']/.test(src) ||
        /require\s*\(\s*["']electron["']\s*\)/.test(src) ||
        /child_process/.test(src) ||
        /@prisma\/client/.test(src) ||
        /from\s+["']node:fs["']/.test(src)
      ) {
        offenders.push(path.relative(DESKTOP_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
