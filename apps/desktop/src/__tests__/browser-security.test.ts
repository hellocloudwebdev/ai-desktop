// PR34: apps/desktop — Browser Subsystem Security Suite
//
// Invariants strictly enforced and verified:
//   a. URL Policy Rejections (javascript:, vbscript:, data:, file:, blob: rejected).
//   b. No arbitrary evaluate / script execution tool in BROWSER_TOOL_IDS or executor.
//   c. Element reference scoping across pages and invalidation on navigation/close.
//   d. Sensitive field & credential protection (redaction and risk escalation).
//   e. Project isolation: sessions and pages strictly scoped to their owning project.
//   f. Bounded outputs & resource limits (MAX_SESSIONS, MAX_PAGES_PER_SESSION, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_BYTES).
//   g. Renderer static security scan (no puppeteer, child_process, fs, or dangerouslySetInnerHTML).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_TOOL_IDS,
  browserRiskFor,
  isSafeBrowserUrl,
  isSensitiveField,
  MAX_PAGES_PER_SESSION,
  MAX_SESSIONS,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ELEMENTS,
  redactSensitiveValue,
  type PermissionCheck,
  type PermissionDecisionResult,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/permissions";
import {
  BrowserNavigationDenied,
  BrowserPageNotFound,
  BrowserResourceLimit,
  BrowserStaleReference,
} from "../main/browser/browser-errors.js";
import { BrowserNavigationPolicy } from "../main/browser/browser-policy.js";
import { BrowserRefRegistry } from "../main/browser/browser-ref-registry.js";
import { DefaultBrowserManager } from "../main/browser/browser-manager.js";
import { BrowserService } from "../main/browser/browser-service.js";
import { BrowserToolExecutor } from "../main/browser/browser-tool-executor.js";
import type {
  BrowserEngineAdapter,
  EngineActionOptions,
  EngineBrowser,
  EngineConnectOptions,
  EngineContext,
  EngineGotoOptions,
  EngineLaunchOptions,
  EnginePage,
  EngineScreenshotOptions,
  EngineWaitOptions,
  RawSnapshotData,
  RawSnapshotElement,
} from "../main/browser/browser-types.js";

// ---------------------------------------------------------------------------
// Security Test Doubles
// ---------------------------------------------------------------------------

class AllowAllPermissions implements PermissionManager {
  readonly checks: PermissionCheck[] = [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return { kind: "allow" };
  }

  async resolve(): Promise<boolean> {
    return true;
  }

  async revoke(): Promise<number> {
    return 0;
  }

  getPendingRequest(): undefined {
    return undefined;
  }

  listPendingRequests(): readonly [] {
    return [];
  }

  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class SecurityMockEnginePage implements EnginePage {
  readonly id = "sec-page-1";
  currentUrl = "about:blank";
  currentTitle = "Blank";
  closed = false;
  readonly calls: string[] = [];
  customSnapshotData?: RawSnapshotData;

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async goto(url: string, _options?: EngineGotoOptions): Promise<void> {
    void _options;
    this.calls.push(`goto:${url}`);
    this.currentUrl = url;
    this.currentTitle = `Title: ${url}`;
  }

  async snapshot(): Promise<RawSnapshotData> {
    this.calls.push("snapshot");
    if (this.customSnapshotData) {
      return this.customSnapshotData;
    }
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      text: "Default page text",
      elements: [
        {
          role: "textbox",
          name: "username",
          selector: "#username",
          value: "test",
        },
        {
          role: "button",
          name: "Submit",
          selector: "#submit",
          text: "Submit",
        },
      ],
    };
  }

  async click(selector: string, _options?: EngineActionOptions): Promise<void> {
    void _options;
    this.calls.push(`click:${selector}`);
  }

  async fill(selector: string, value: string, _options?: EngineActionOptions): Promise<void> {
    void _options;
    this.calls.push(`fill:${selector}:${value}`);
  }

  async select(
    selector: string,
    values: readonly string[],
    _options?: EngineActionOptions,
  ): Promise<void> {
    void _options;
    this.calls.push(`select:${selector}:${values.join(",")}`);
  }

  async press(key: string, _options?: EngineActionOptions): Promise<void> {
    void _options;
    this.calls.push(`press:${key}`);
  }

  async wait(options: EngineWaitOptions, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.calls.push(`wait:${options.condition}`);
  }

  async screenshot(_options?: EngineScreenshotOptions): Promise<Buffer> {
    void _options;
    this.calls.push("screenshot");
    return Buffer.from("mock-png");
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class SecurityMockEngineContext implements EngineContext {
  readonly pages: SecurityMockEnginePage[] = [];

  async newPage(): Promise<EnginePage> {
    const page = new SecurityMockEnginePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    for (const page of this.pages) {
      await page.close();
    }
  }
}

class SecurityMockEngineBrowser implements EngineBrowser {
  readonly contexts: SecurityMockEngineContext[] = [];
  connected = true;

  async createContext(): Promise<EngineContext> {
    const ctx = new SecurityMockEngineContext();
    this.contexts.push(ctx);
    return ctx;
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const ctx of this.contexts) {
      await ctx.close();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

class SecurityMockBrowserEngineAdapter implements BrowserEngineAdapter {
  browser = new SecurityMockEngineBrowser();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async launch(_options?: EngineLaunchOptions): Promise<EngineBrowser> {
    void _options;
    return this.browser;
  }

  async connect(_options: EngineConnectOptions): Promise<EngineBrowser> {
    void _options;
    return this.browser;
  }
}

// ---------------------------------------------------------------------------
// Security Suite
// ---------------------------------------------------------------------------

describe("apps/desktop: Browser Security Suite", () => {
  // -------------------------------------------------------------------------
  // a. URL Policy Rejections
  // -------------------------------------------------------------------------
  describe("a. URL Policy Rejections", () => {
    const dangerousUrls = [
      "javascript:alert(1)",
      "javascript:void(0)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "file:///C:/Windows/win.ini",
      "blob:http://example.com/8f52f821-65f8-45a7-96a8-20295dae65c0",
    ];

    it("isSafeBrowserUrl strictly rejects dangerous schemes and accepts http/https/about:blank", () => {
      for (const url of dangerousUrls) {
        expect(isSafeBrowserUrl(url), `Expected dangerous url "${url}" to be rejected`).toBe(false);
      }

      expect(isSafeBrowserUrl("http://127.0.0.1:8080/")).toBe(true);
      expect(isSafeBrowserUrl("https://example.com/login")).toBe(true);
      expect(isSafeBrowserUrl("about:blank")).toBe(true);
      expect(isSafeBrowserUrl("")).toBe(false);
    });

    it("BrowserNavigationPolicy rejects dangerous URLs and enforces allowedHostnames filter", () => {
      const defaultPolicy = new BrowserNavigationPolicy();
      for (const url of dangerousUrls) {
        expect(defaultPolicy.isAllowed(url)).toBe(false);
        expect(() => defaultPolicy.assertAllowed(url)).toThrow(BrowserNavigationDenied);
      }

      const restrictedPolicy = new BrowserNavigationPolicy({
        allowedHostnames: ["example.com", "*.trusted.org"],
      });
      expect(restrictedPolicy.isAllowed("https://example.com/page")).toBe(true);
      expect(restrictedPolicy.isAllowed("https://api.trusted.org/v1")).toBe(true);
      expect(restrictedPolicy.isAllowed("https://malicious.org")).toBe(false);
      expect(() => restrictedPolicy.assertAllowed("https://malicious.org")).toThrow(
        BrowserNavigationDenied,
      );
    });

    it("BrowserToolExecutor.execute('builtin:browser.open', ...) fails before calling browser engine", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });
      const executor = new BrowserToolExecutor({
        permissionManager: new AllowAllPermissions(),
        browserService: service,
      });

      const result = await executor.execute("builtin:browser.open", {
        url: "javascript:alert(1)",
      });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("NAVIGATION_DENIED");

      // Verify no page was ever opened in the browser engine
      const pages = adapter.browser.contexts.flatMap((c) => c.pages);
      expect(pages.length).toBe(0);

      await service.close();
    });

    it("BrowserToolExecutor.execute('builtin:browser.navigate', ...) fails before calling browser engine", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });
      const executor = new BrowserToolExecutor({
        permissionManager: new AllowAllPermissions(),
        browserService: service,
      });

      // First open a safe page
      const openResult = await executor.execute("builtin:browser.open", {
        url: "http://127.0.0.1:3000/",
      });
      expect(openResult.isError).toBe(false);
      const page = JSON.parse(openResult.result as string);

      const navResult = await executor.execute("builtin:browser.navigate", {
        pageId: page.id,
        url: "file:///C:/Windows/win.ini",
      });

      expect(navResult.isError).toBe(true);
      expect(navResult.result).toContain("NAVIGATION_DENIED");

      // Verify engine page never navigated to the file URL
      const enginePage = adapter.browser.contexts[0]?.pages[0];
      expect(enginePage?.calls).not.toContain("goto:file:///C:/Windows/win.ini");

      await service.close();
    });
  });

  // -------------------------------------------------------------------------
  // b. No arbitrary evaluate tool
  // -------------------------------------------------------------------------
  describe("b. No arbitrary evaluate tool", () => {
    it("verify BROWSER_TOOL_IDS does NOT contain browser.evaluate, page.evaluate, or arbitrary script execution", () => {
      const toolIds = BROWSER_TOOL_IDS as readonly string[];
      expect(toolIds).not.toContain("browser.evaluate");
      expect(toolIds).not.toContain("page.evaluate");
      expect(toolIds).not.toContain("builtin:browser.evaluate");
      expect(toolIds).not.toContain("builtin:browser.eval");
      expect(toolIds).not.toContain("builtin:browser.executeScript");

      for (const id of toolIds) {
        expect(id).not.toMatch(/evaluate|eval|exec/i);
      }
    });

    it("verify BrowserToolExecutor rejects any tool name not in BROWSER_TOOL_IDS", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });
      const executor = new BrowserToolExecutor({
        permissionManager: new AllowAllPermissions(),
        browserService: service,
      });

      expect(executor.hasTool("builtin:browser.evaluate")).toBe(false);
      expect(executor.hasTool("page.evaluate")).toBe(false);
      expect(executor.resolve("builtin:browser.evaluate")).toBeUndefined();

      await expect(
        executor.execute("builtin:browser.evaluate", { script: "alert(1)" }),
      ).rejects.toThrow(ValidationError);

      await expect(executor.execute("page.evaluate", { script: "alert(1)" })).rejects.toThrow(
        ValidationError,
      );

      await expect(executor.execute("arbitrary.tool", {})).rejects.toThrow(ValidationError);

      await service.close();
    });
  });

  // -------------------------------------------------------------------------
  // c. Element Reference Scoping & Invalidation
  // -------------------------------------------------------------------------
  describe("c. Element Reference Scoping & Invalidation", () => {
    it("element ref from Page 1 cannot be used on Page 2 (throws BrowserStaleReference)", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const registry = new BrowserRefRegistry();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter, refRegistry: registry });

      const session = await manager.createSession({ projectId: "proj-scope" });
      const page1 = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/page1" });
      const page2 = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/page2" });

      const snap1 = await manager.snapshot(page1.id);
      expect(snap1.elements.length).toBeGreaterThan(0);
      const page1Ref = snap1.elements[0].ref;

      // Attempting to resolve page1's ref against page2 directly or via click/fill
      expect(() => registry.resolve(page2.id, page1Ref)).toThrow(BrowserStaleReference);
      await expect(manager.click(page2.id, page1Ref)).rejects.toThrow(BrowserStaleReference);
      await expect(manager.fill(page2.id, page1Ref, "value")).rejects.toThrow(
        BrowserStaleReference,
      );

      await manager.close();
    });

    it("navigation invalidates existing element refs for that page", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const registry = new BrowserRefRegistry();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter, refRegistry: registry });

      const session = await manager.createSession({ projectId: "proj-nav" });
      const page = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/initial" });

      const snap = await manager.snapshot(page.id);
      const ref = snap.elements[0].ref;
      expect(registry.resolve(page.id, ref)).toBeDefined();

      // Navigate to new URL
      await manager.navigate(page.id, "http://127.0.0.1:3000/next");

      // Ref is now invalidated and stale
      expect(() => registry.resolve(page.id, ref)).toThrow(BrowserStaleReference);
      await expect(manager.click(page.id, ref)).rejects.toThrow(BrowserStaleReference);

      await manager.close();
    });

    it("closed page invalidates all refs and prevents actions", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const registry = new BrowserRefRegistry();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter, refRegistry: registry });

      const session = await manager.createSession({ projectId: "proj-close" });
      const page = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/page" });

      const snap = await manager.snapshot(page.id);
      const ref = snap.elements[0].ref;

      await manager.closePage(page.id);

      // Refs are removed from registry
      expect(() => registry.resolve(page.id, ref)).toThrow(BrowserStaleReference);

      // Manager methods throw BrowserPageNotFound
      await expect(manager.click(page.id, ref)).rejects.toThrow(BrowserPageNotFound);
      await expect(manager.snapshot(page.id)).rejects.toThrow(BrowserPageNotFound);
      await expect(manager.navigate(page.id, "http://127.0.0.1:3000/another")).rejects.toThrow(
        BrowserPageNotFound,
      );

      await manager.close();
    });
  });

  // -------------------------------------------------------------------------
  // d. Sensitive field & Credential protection
  // -------------------------------------------------------------------------
  describe("d. Sensitive field & Credential protection", () => {
    it("isSensitiveField correctly classifies sensitive credential field names", () => {
      const sensitiveNames = [
        "password",
        "current_password",
        "new-password",
        "user_passcode",
        "apiKey",
        "api_key",
        "SECRET_TOKEN",
        "authToken",
        "credit_card_number",
        "card_auth_code",
      ];

      for (const name of sensitiveNames) {
        expect(isSensitiveField(name), `Expected "${name}" to be sensitive`).toBe(true);
      }

      const nonSensitiveNames = ["username", "email", "query", "search", "first_name", "comment"];
      for (const name of nonSensitiveNames) {
        expect(isSensitiveField(name), `Expected "${name}" to not be sensitive`).toBe(false);
      }
    });

    it("redactSensitiveValue redacts non-empty credential values and leaves empty strings untouched", () => {
      expect(redactSensitiveValue("secret123")).toBe("[REDACTED]");
      expect(redactSensitiveValue("ghp_live_token_abcdef123456")).toBe("[REDACTED]");
      expect(redactSensitiveValue("")).toBe("");
    });

    it("browserRiskFor escalates risk to 'high' for sensitive field inputs", () => {
      expect(browserRiskFor("fill", "current_password")).toBe("high");
      expect(browserRiskFor("fill", "apiKey")).toBe("high");
      expect(browserRiskFor("fill", "username")).toBe("medium");
      expect(browserRiskFor("click")).toBe("medium");
      expect(browserRiskFor("snapshot")).toBe("low");
      expect(browserRiskFor("pages")).toBe("low");
    });

    it("BrowserToolExecutor elevates permission check risk to 'high' when interacting with sensitive fields", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });
      const permissions = new AllowAllPermissions();
      const executor = new BrowserToolExecutor({
        permissionManager: permissions,
        browserService: service,
      });

      const openRes = await executor.execute("builtin:browser.open", {
        url: "http://127.0.0.1:3000/login",
      });
      const page = JSON.parse(openRes.result as string);

      // Fill a normal field
      await executor.execute("builtin:browser.fill", {
        pageId: page.id,
        ref: "ref/username",
        value: "user1",
      });

      // Fill a sensitive field
      await executor.execute("builtin:browser.fill", {
        pageId: page.id,
        ref: "ref/password",
        value: "secret123",
      });

      const fillChecks = permissions.checks.filter((c) => c.action === "fill");
      expect(fillChecks.length).toBe(2);
      expect(fillChecks[0].risk).toBe("medium");
      expect(fillChecks[1].risk).toBe("high");

      await service.close();
    });
  });

  // -------------------------------------------------------------------------
  // e. Project Isolation
  // -------------------------------------------------------------------------
  describe("e. Project Isolation", () => {
    it("sessions created for 'project-A' cannot be listed or accessed by 'project-B'", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });

      const sessionA = await manager.createSession({ projectId: "project-A" });
      const sessionB = await manager.createSession({ projectId: "project-B" });

      const sessionsA = manager.listSessions("project-A");
      expect(sessionsA.map((s) => s.id)).toContain(sessionA.id);
      expect(sessionsA.map((s) => s.id)).not.toContain(sessionB.id);

      const sessionsB = manager.listSessions("project-B");
      expect(sessionsB.map((s) => s.id)).toContain(sessionB.id);
      expect(sessionsB.map((s) => s.id)).not.toContain(sessionA.id);

      // BrowserService lists pages filtered by project
      const pageA = await manager.openPage(sessionA.id, { url: "http://127.0.0.1:3000/a" });
      const pageB = await manager.openPage(sessionB.id, { url: "http://127.0.0.1:3000/b" });

      const servicePagesA = (await service.executeAction(
        "pages",
        {},
        { projectId: "project-A", toolCallId: "tc-1" as never },
      )) as Array<{ id: string }>;
      expect(servicePagesA.map((p) => p.id)).toContain(pageA.id);
      expect(servicePagesA.map((p) => p.id)).not.toContain(pageB.id);

      await service.close();
    });

    it("page opened in Project A cannot be closed, navigated, or accessed by Project B", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const service = new BrowserService({ browserManager: manager });
      const executor = new BrowserToolExecutor({
        permissionManager: new AllowAllPermissions(),
        browserService: service,
      });

      // Open page in Project A
      const openResult = await executor.execute(
        "builtin:browser.open",
        { url: "http://127.0.0.1:3000/isolated" },
        { projectId: "project-A" },
      );
      const pageA = JSON.parse(openResult.result as string);

      // Project B attempts to navigate Page A
      await expect(
        service.executeAction(
          "navigate",
          { pageId: pageA.id, url: "http://127.0.0.1:3000/hacked" },
          { projectId: "project-B", toolCallId: "tc-sec-nav" as never },
        ),
      ).rejects.toThrow(BrowserPageNotFound);

      // Project B attempts to close Page A
      await expect(
        service.executeAction(
          "close",
          { pageId: pageA.id },
          { projectId: "project-B", toolCallId: "tc-sec-close" as never },
        ),
      ).rejects.toThrow(BrowserPageNotFound);

      // Project B attempts through BrowserToolExecutor
      const execNavResult = await executor.execute(
        "builtin:browser.navigate",
        { pageId: pageA.id, url: "http://127.0.0.1:3000/hacked" },
        { projectId: "project-B" },
      );
      expect(execNavResult.isError).toBe(true);
      expect(execNavResult.result).toContain("PAGE_NOT_FOUND");

      await service.close();
    });
  });

  // -------------------------------------------------------------------------
  // f. Bounded outputs & resource limits
  // -------------------------------------------------------------------------
  describe("f. Bounded outputs & resource limits", () => {
    it("enforces MAX_SESSIONS limit (10)", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });

      // Create up to MAX_SESSIONS
      for (let i = 0; i < MAX_SESSIONS; i++) {
        await manager.createSession({ projectId: `proj-limit-${i}` });
      }

      // Next session creation exceeds limit
      await expect(manager.createSession({ projectId: "proj-overflow" })).rejects.toThrow(
        BrowserResourceLimit,
      );

      await manager.close();
    });

    it("enforces MAX_PAGES_PER_SESSION limit (20)", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const session = await manager.createSession({ projectId: "proj-pages-limit" });

      // Open up to MAX_PAGES_PER_SESSION
      for (let i = 0; i < MAX_PAGES_PER_SESSION; i++) {
        await manager.openPage(session.id, { url: "about:blank" });
      }

      // Next page open exceeds limit
      await expect(manager.openPage(session.id, { url: "about:blank" })).rejects.toThrow(
        BrowserResourceLimit,
      );

      await manager.close();
    });

    it("truncates snapshot elements to MAX_SNAPSHOT_ELEMENTS (200)", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const session = await manager.createSession({ projectId: "proj-snap-limit" });
      const page = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/large" });

      // Mock engine page returning 250 elements
      const mockPage = adapter.browser.contexts[0].pages[0];
      const elements: RawSnapshotElement[] = [];
      for (let i = 0; i < 250; i++) {
        elements.push({
          role: "button",
          name: `Btn ${i}`,
          selector: `#btn-${i}`,
        });
      }
      mockPage.customSnapshotData = {
        url: "http://127.0.0.1:3000/large",
        title: "Large Page",
        text: "Large page content",
        elements,
      };

      const snap = await manager.snapshot(page.id);
      expect(snap.elements.length).toBe(MAX_SNAPSHOT_ELEMENTS);
      expect(snap.truncated).toBe(true);

      await manager.close();
    });

    it("truncates snapshot byte size when exceeding MAX_SNAPSHOT_BYTES (64KB)", async () => {
      const adapter = new SecurityMockBrowserEngineAdapter();
      const manager = new DefaultBrowserManager({ engineAdapter: adapter });
      const session = await manager.createSession({ projectId: "proj-bytes-limit" });
      const page = await manager.openPage(session.id, { url: "http://127.0.0.1:3000/heavy" });

      // Elements with large payloads
      const mockPage = adapter.browser.contexts[0].pages[0];
      const elements: RawSnapshotElement[] = [];
      const largeText = "A".repeat(1500);
      for (let i = 0; i < 100; i++) {
        elements.push({
          role: "textbox",
          name: `Input ${i}`,
          text: largeText,
          value: largeText,
          selector: `#input-${i}`,
        });
      }
      mockPage.customSnapshotData = {
        url: "http://127.0.0.1:3000/heavy",
        title: "Heavy Page",
        text: "Heavy page content",
        elements,
      };

      const snap = await manager.snapshot(page.id);
      const totalBytes = JSON.stringify(snap.elements).length;
      expect(totalBytes).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
      expect(snap.truncated).toBe(true);

      await manager.close();
    });
  });

  // -------------------------------------------------------------------------
  // g. Renderer Security
  // -------------------------------------------------------------------------
  describe("g. Renderer Security", () => {
    const RENDERER_ROOT = path.resolve(__dirname, "../renderer");

    function scanFiles(
      dir: string,
    ): Array<{ filePath: string; content: string; isTestFile: boolean }> {
      const results: Array<{ filePath: string; content: string; isTestFile: boolean }> = [];
      if (!fs.existsSync(dir)) return results;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanFiles(full));
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const content = fs.readFileSync(full, "utf8");
          const isTestFile =
            full.includes("__tests__") ||
            entry.name.includes(".test.") ||
            entry.name.includes(".spec.");
          results.push({ filePath: full, content, isTestFile });
        }
      }
      return results;
    }

    const files = scanFiles(RENDERER_ROOT);

    it("verifies renderer directory contains scanned source files", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it("renderer files contain zero puppeteer imports", () => {
      const puppeteerImportPattern =
        /(from\s+["']puppeteer.*["']|require\s*\(\s*["']puppeteer.*["']\))/i;

      for (const file of files) {
        expect(
          puppeteerImportPattern.test(file.content),
          `Found forbidden puppeteer import in ${file.filePath}`,
        ).toBe(false);
      }
    });

    it("renderer files contain zero child_process imports", () => {
      const childProcessPattern =
        /(from\s+["'](node:)?child_process["']|require\s*\(\s*["'](node:)?child_process["']\))/i;

      for (const file of files) {
        expect(
          childProcessPattern.test(file.content),
          `Found forbidden child_process import in ${file.filePath}`,
        ).toBe(false);
      }
    });

    it("non-test renderer files contain zero node:fs or fs imports", () => {
      const fsPattern =
        /(from\s+["'](node:)?fs(\/promises)?["']|require\s*\(\s*["'](node:)?fs(\/promises)?["']\))/;

      const nonTestFiles = files.filter((f) => !f.isTestFile);
      expect(nonTestFiles.length).toBeGreaterThan(0);

      for (const file of nonTestFiles) {
        expect(
          fsPattern.test(file.content),
          `Found forbidden fs import in non-test renderer file ${file.filePath}`,
        ).toBe(false);
      }
    });

    it("non-test renderer files contain zero dangerouslySetInnerHTML usage", () => {
      const nonTestFiles = files.filter((f) => !f.isTestFile);

      for (const file of nonTestFiles) {
        expect(
          file.content.includes("dangerouslySetInnerHTML"),
          `Found forbidden dangerouslySetInnerHTML in ${file.filePath}`,
        ).toBe(false);
      }
    });
  });
});
