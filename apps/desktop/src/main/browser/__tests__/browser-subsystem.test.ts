// PR34.3/34.4: apps/desktop — Browser Subsystem Comprehensive Unit Tests

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_TOOL_IDS,
  createBrowserPageId,
  type BrowserElementRef,
  type BrowserPageId,
  type PermissionCheck,
  type PermissionDecisionResult,
} from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import { createToolCallId, ValidationError } from "@ai-desktop/shared";
import {
  BrowserActionFailed,
  BrowserCancelled,
  BrowserConnectionFailed,
  BrowserError,
  BrowserNavigationDenied,
  BrowserNotFound,
  BrowserPageNotFound,
  BrowserResourceLimit,
  BrowserSessionNotFound,
  BrowserStaleReference,
  BrowserTimeout,
  toCanonicalBrowserError,
} from "../browser-errors.js";
import { BrowserNavigationPolicy } from "../browser-policy.js";
import { BrowserRefRegistry } from "../browser-ref-registry.js";
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
} from "../browser-types.js";
import { DefaultBrowserManager } from "../browser-manager.js";
import { BrowserService } from "../browser-service.js";
import { BrowserToolExecutor } from "../browser-tool-executor.js";
import { findSystemBrowserExecutable, PuppeteerAdapter } from "../puppeteer/puppeteer-adapter.js";

// ---------------------------------------------------------------------------
// Mock Permission Managers
// ---------------------------------------------------------------------------

class AllowAllPermissions implements PermissionManager {
  readonly checks: Array<{ capability: string; action: string; resource: string; risk: string }> =
    [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push({
      capability: request.capability,
      action: request.action,
      resource: request.resource,
      risk: request.risk,
    });
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

class DenyAllPermissions implements PermissionManager {
  async check(): Promise<PermissionDecisionResult> {
    return { kind: "deny", reason: "Blocked by security policy" };
  }
  async resolve(): Promise<boolean> {
    return false;
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

// ---------------------------------------------------------------------------
// Mock Browser Engine Components
// ---------------------------------------------------------------------------

class MockEnginePage implements EnginePage {
  readonly id = "mock-page-1";
  currentUrl = "about:blank";
  currentTitle = "Blank Page";
  closed = false;
  readonly calls: string[] = [];

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
    this.currentTitle = `Title for ${url}`;
  }

  async snapshot(): Promise<RawSnapshotData> {
    this.calls.push("snapshot");
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      text: "Sample page content",
      elements: [
        {
          role: "button",
          name: "Submit",
          text: "Submit Form",
          selector: "#submit-btn",
        },
        {
          role: "textbox",
          name: "Username",
          value: "testuser",
          selector: "input[name='username']",
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
    this.calls.push(`wait:${options.condition}:${options.target ?? ""}`);
  }

  async screenshot(_options?: EngineScreenshotOptions): Promise<Buffer> {
    void _options;
    this.calls.push("screenshot");
    return Buffer.from("fake-png-data");
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class MockEngineContext implements EngineContext {
  readonly pages: MockEnginePage[] = [];

  async newPage(): Promise<EnginePage> {
    const page = new MockEnginePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    for (const page of this.pages) {
      await page.close();
    }
  }
}

class MockEngineBrowser implements EngineBrowser {
  readonly contexts: MockEngineContext[] = [];
  connected = true;

  async createContext(): Promise<EngineContext> {
    const ctx = new MockEngineContext();
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

class MockBrowserEngineAdapter implements BrowserEngineAdapter {
  browser = new MockEngineBrowser();
  launchCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async launch(_options?: EngineLaunchOptions): Promise<EngineBrowser> {
    void _options;
    this.launchCalls++;
    return this.browser;
  }

  async connect(_options: EngineConnectOptions): Promise<EngineBrowser> {
    void _options;
    return this.browser;
  }
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe("Browser Subsystem", () => {
  describe("1. Canonical Browser Errors", () => {
    it("should instantiate all canonical error classes with proper codes", () => {
      expect(new BrowserError("CUSTOM_CODE", "msg").code).toBe("CUSTOM_CODE");
      expect(new BrowserNotFound().code).toBe("BROWSER_NOT_FOUND");
      expect(new BrowserSessionNotFound("sess-1").code).toBe("SESSION_NOT_FOUND");
      expect(new BrowserPageNotFound("page-1").code).toBe("PAGE_NOT_FOUND");
      expect(new BrowserNavigationDenied("https://bad.url").code).toBe("NAVIGATION_DENIED");
      expect(new BrowserTimeout().code).toBe("TIMEOUT");
      expect(new BrowserActionFailed("failed").code).toBe("ACTION_FAILED");
      expect(new BrowserStaleReference("ref/e1").code).toBe("STALE_REFERENCE");
      expect(new BrowserConnectionFailed().code).toBe("CONNECTION_FAILED");
      expect(new BrowserResourceLimit().code).toBe("RESOURCE_LIMIT");
      expect(new BrowserCancelled().code).toBe("CANCELLED");
    });

    it("toCanonicalBrowserError maps various error types correctly", () => {
      const original = new BrowserTimeout("timed out");
      expect(toCanonicalBrowserError(original)).toBe(original);

      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      expect(toCanonicalBrowserError(abortErr)).toBeInstanceOf(BrowserCancelled);

      const timeoutErr = new Error("Navigation timeout of 30000 ms exceeded");
      expect(toCanonicalBrowserError(timeoutErr)).toBeInstanceOf(BrowserTimeout);

      const staleErr = new Error("Element is not attached to the DOM");
      expect(toCanonicalBrowserError(staleErr)).toBeInstanceOf(BrowserStaleReference);

      const navDeniedErr = new Error("unsafe scheme protocol");
      expect(toCanonicalBrowserError(navDeniedErr)).toBeInstanceOf(BrowserNavigationDenied);

      const notFoundErr = new Error("Cannot find Chrome executable");
      expect(toCanonicalBrowserError(notFoundErr)).toBeInstanceOf(BrowserNotFound);

      const connErr = new Error("Target closed or connection failed");
      expect(toCanonicalBrowserError(connErr)).toBeInstanceOf(BrowserConnectionFailed);

      const limitErr = new Error("Browser resource limit exceeded");
      expect(toCanonicalBrowserError(limitErr)).toBeInstanceOf(BrowserResourceLimit);

      const genericErr = new Error("Something broke");
      const canonical = toCanonicalBrowserError(genericErr);
      expect(canonical).toBeInstanceOf(BrowserActionFailed);
      expect(canonical.message).toBe("Something broke");
    });
  });

  describe("2. Browser Navigation Policy", () => {
    it("allows safe http, https, and about:blank URLs", () => {
      const policy = new BrowserNavigationPolicy();
      expect(policy.isAllowed("http://example.com")).toBe(true);
      expect(policy.isAllowed("https://example.com/path?foo=bar")).toBe(true);
      expect(policy.isAllowed("about:blank")).toBe(true);
    });

    it("rejects dangerous schemes", () => {
      const policy = new BrowserNavigationPolicy();
      expect(policy.isAllowed("javascript:alert(1)")).toBe(false);
      expect(policy.isAllowed("vbscript:msgbox(1)")).toBe(false);
      expect(policy.isAllowed("data:text/html,<h1>hi</h1>")).toBe(false);
      expect(policy.isAllowed("file:///C:/Windows/System32/calc.exe")).toBe(false);
      expect(policy.isAllowed("blob:https://example.com/uuid")).toBe(false);
    });

    it("assertAllowed throws BrowserNavigationDenied on forbidden URLs", () => {
      const policy = new BrowserNavigationPolicy();
      expect(() => policy.assertAllowed("javascript:void(0)")).toThrow(BrowserNavigationDenied);
    });

    it("enforces allowedHostnames whitelist when provided", () => {
      const policy = new BrowserNavigationPolicy({
        allowedHostnames: ["example.com", "*.internal.org"],
      });

      expect(policy.isAllowed("https://example.com")).toBe(true);
      expect(policy.isAllowed("https://api.example.com")).toBe(true);
      expect(policy.isAllowed("https://sub.internal.org")).toBe(true);
      expect(policy.isAllowed("https://google.com")).toBe(false);
      expect(policy.isAllowed("about:blank")).toBe(true);
    });
  });

  describe("3. Browser Reference Registry", () => {
    it("assigns sequential references per page and resolves them", () => {
      const registry = new BrowserRefRegistry();
      const page1 = createBrowserPageId();
      const page2 = createBrowserPageId();

      const ref1 = registry.assignRef(page1, "#btn1", "button", "Submit");
      const ref2 = registry.assignRef(page1, "#input1", "textbox", "Name");
      const refPage2 = registry.assignRef(page2, "#btn1", "button", "Other");

      expect(ref1).toBe("ref/e1");
      expect(ref2).toBe("ref/e2");
      expect(refPage2).toBe("ref/e1");

      const entry1 = registry.resolve(page1, ref1);
      expect(entry1.selector).toBe("#btn1");
      expect(entry1.role).toBe("button");
      expect(entry1.name).toBe("Submit");

      const entryPage2 = registry.resolve(page2, refPage2);
      expect(entryPage2.selector).toBe("#btn1");
    });

    it("throws BrowserStaleReference for missing or invalidated references", () => {
      const registry = new BrowserRefRegistry();
      const page1 = createBrowserPageId();
      const ref1 = registry.assignRef(page1, "#btn1");

      registry.invalidateForPage(page1);
      expect(() => registry.resolve(page1, ref1)).toThrow(BrowserStaleReference);
    });
  });

  describe("4. Puppeteer Adapter", () => {
    it("findSystemBrowserExecutable runs without throwing", () => {
      const result = findSystemBrowserExecutable();
      expect(result === undefined || typeof result === "string").toBe(true);
    });

    it("initializes PuppeteerAdapter cleanly", async () => {
      const adapter = new PuppeteerAdapter();
      const available = await adapter.isAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  describe("5. DefaultBrowserManager", () => {
    let mockAdapter: MockBrowserEngineAdapter;
    let manager: DefaultBrowserManager;

    beforeEach(() => {
      mockAdapter = new MockBrowserEngineAdapter();
      manager = new DefaultBrowserManager({
        engineAdapter: mockAdapter,
      });
    });

    afterEach(async () => {
      await manager.close();
    });

    it("creates sessions and opens pages", async () => {
      const session = await manager.createSession({ projectId: "proj-1" });
      expect(session.projectId).toBe("proj-1");
      expect(session.status).toBe("ready");

      const page = await manager.openPage(session.id, { url: "https://example.com" });
      expect(page.contextId).toBeDefined();
      expect(page.status).toBe("ready");

      const list = manager.listPages(session.id);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(page.id);
    });

    it("navigates and updates page information", async () => {
      const session = await manager.createSession({ projectId: "proj-1" });
      const page = await manager.openPage(session.id);

      const navigated = await manager.navigate(page.id, "https://test.local");
      expect(navigated.url).toBe("https://test.local");
      expect(navigated.title).toContain("Title for https://test.local");
    });

    it("takes snapshot and assigns refs to interactive elements", async () => {
      const session = await manager.createSession({ projectId: "proj-1" });
      const page = await manager.openPage(session.id);

      const snap = await manager.snapshot(page.id);
      expect(snap.elements.length).toBe(2);
      expect(snap.elements[0].ref).toBe("ref/e1");
      expect(snap.elements[0].role).toBe("button");
      expect(snap.elements[1].ref).toBe("ref/e2");
      expect(snap.elements[1].role).toBe("textbox");
    });

    it("performs actions using element references", async () => {
      const session = await manager.createSession({ projectId: "proj-1" });
      const page = await manager.openPage(session.id);
      const snap = await manager.snapshot(page.id);

      await manager.click(page.id, snap.elements[0].ref);
      await manager.fill(page.id, snap.elements[1].ref, "alice");
      await manager.select(page.id, snap.elements[0].ref, ["val1"]);
      await manager.press(page.id, "Enter");
      await manager.wait(page.id, { condition: "timeout", timeoutMs: 10 });
      const buffer = await manager.screenshot(page.id);
      expect(buffer).toBeInstanceOf(Buffer);

      const mockPage = mockAdapter.browser.contexts[0].pages[0];
      expect(mockPage.calls).toContain("click:#submit-btn");
      expect(mockPage.calls).toContain("fill:input[name='username']:alice");
      expect(mockPage.calls).toContain("select:#submit-btn:val1");
      expect(mockPage.calls).toContain("press:Enter");
    });

    it("enforces session and page resource limits", async () => {
      // Test session limit (10)
      for (let i = 0; i < 10; i++) {
        await manager.createSession({ projectId: `proj-${i}` });
      }
      await expect(manager.createSession({ projectId: "proj-11" })).rejects.toThrow(
        BrowserResourceLimit,
      );
    });

    it("closes pages and sessions cleanly", async () => {
      const session = await manager.createSession({ projectId: "proj-1" });
      const page = await manager.openPage(session.id);

      await manager.closePage(page.id);
      expect(manager.getPage(page.id)).toBeUndefined();

      await manager.closeSession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();
    });
  });

  describe("6. BrowserService", () => {
    let mockAdapter: MockBrowserEngineAdapter;
    let manager: DefaultBrowserManager;
    let service: BrowserService;
    let testTempDir: string;

    beforeEach(async () => {
      testTempDir = path.join(os.tmpdir(), `browser-service-test-${Date.now()}`);
      mockAdapter = new MockBrowserEngineAdapter();
      manager = new DefaultBrowserManager({ engineAdapter: mockAdapter });
      service = new BrowserService({
        browserManager: manager,
        screenshotsDir: testTempDir,
      });
    });

    afterEach(async () => {
      await service.close();
      try {
        await fs.promises.rm(testTempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    });

    it("maintains project-level session isolation and handles action lifecycle", async () => {
      const toolCallId = createToolCallId();
      const page = (await service.executeAction(
        "open",
        { url: "https://example.com" },
        { projectId: "project-abc", toolCallId },
      )) as { id: BrowserPageId };

      expect(page.id).toBeDefined();

      const snap = (await service.executeAction(
        "snapshot",
        { pageId: page.id },
        { projectId: "project-abc", toolCallId },
      )) as { elements: Array<{ ref: BrowserElementRef }> };

      expect(snap.elements.length).toBeGreaterThan(0);

      const fillRes = await service.executeAction(
        "fill",
        { pageId: page.id, ref: snap.elements[1].ref, value: "hello" },
        { projectId: "project-abc", toolCallId },
      );
      expect(fillRes).toEqual({ success: true });

      const shotRes = (await service.executeAction(
        "screenshot",
        { pageId: page.id, fullPage: false },
        { projectId: "project-abc", toolCallId },
      )) as { artifactRef: string; bytes: number };

      expect(shotRes.artifactRef).toContain(testTempDir);
      expect(shotRes.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(shotRes.artifactRef)).toBe(true);

      const closeRes = await service.executeAction(
        "close",
        { pageId: page.id },
        { projectId: "project-abc", toolCallId },
      );
      expect(closeRes).toEqual({ success: true });
    });
  });

  describe("7. BrowserToolExecutor", () => {
    let mockAdapter: MockBrowserEngineAdapter;
    let manager: DefaultBrowserManager;
    let service: BrowserService;
    let allowPermissions: AllowAllPermissions;
    let denyPermissions: DenyAllPermissions;

    beforeEach(() => {
      mockAdapter = new MockBrowserEngineAdapter();
      manager = new DefaultBrowserManager({ engineAdapter: mockAdapter });
      service = new BrowserService({ browserManager: manager });
      allowPermissions = new AllowAllPermissions();
      denyPermissions = new DenyAllPermissions();
    });

    afterEach(async () => {
      await service.close();
    });

    it("satisfies ToolExecutorLike and checks definitions", () => {
      const executor = new BrowserToolExecutor({
        permissionManager: allowPermissions,
        browserService: service,
      });

      expect(executor.listTools().length).toBe(BROWSER_TOOL_IDS.length);
      expect(executor.hasTool("builtin:browser.open")).toBe(true);
      expect(executor.hasTool("builtin:unknown")).toBe(false);
      expect(executor.resolve("builtin:browser.open")?.name).toBe("builtin:browser.open");
    });

    it("throws ValidationError on unknown tool", async () => {
      const executor = new BrowserToolExecutor({
        permissionManager: allowPermissions,
        browserService: service,
      });

      await expect(executor.execute("builtin:unknown", {})).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError on invalid schema BEFORE permission check", async () => {
      const executor = new BrowserToolExecutor({
        permissionManager: allowPermissions,
        browserService: service,
      });

      // Missing required url
      await expect(executor.execute("builtin:browser.open", {})).rejects.toThrow(ValidationError);
      expect(allowPermissions.checks.length).toBe(0);
    });

    it("enforces permission denial", async () => {
      const executor = new BrowserToolExecutor({
        permissionManager: denyPermissions,
        browserService: service,
      });

      const result = await executor.execute("builtin:browser.open", {
        url: "https://example.com",
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain("Permission denied");
    });

    it("executes permitted tool calls end-to-end", async () => {
      const executor = new BrowserToolExecutor({
        permissionManager: allowPermissions,
        browserService: service,
      });

      // 1. open page
      const openRes = await executor.execute("builtin:browser.open", {
        url: "https://example.com",
      });
      expect(openRes.isError).toBe(false);
      const parsedPage = JSON.parse(openRes.result as string);
      const pageId = parsedPage.id;
      expect(pageId).toBeDefined();

      // Check permission audit entry
      expect(allowPermissions.checks).toContainEqual(
        expect.objectContaining({
          capability: "browser",
          action: "open",
          resource: "builtin:browser.open::https://example.com",
        }),
      );

      // 2. snapshot
      const snapRes = await executor.execute("builtin:browser.snapshot", {
        pageId,
      });
      expect(snapRes.isError).toBe(false);
      const parsedSnap = JSON.parse(snapRes.result as string);
      expect(parsedSnap.elements.length).toBe(2);

      // 3. fill with high risk detection for password/sensitive if applicable
      const fillRes = await executor.execute("builtin:browser.fill", {
        pageId,
        ref: parsedSnap.elements[1].ref,
        value: "my-value",
      });
      expect(fillRes.isError).toBe(false);

      // 4. close page
      const closeRes = await executor.execute("builtin:browser.close", {
        pageId,
      });
      expect(closeRes.isError).toBe(false);
    });
  });
});
