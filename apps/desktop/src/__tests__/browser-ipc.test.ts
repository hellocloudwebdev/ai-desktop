// PR34.5: apps/desktop — Browser IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All browser:* channels registered (session create/get/close, page open/list/get/close, screenshot).
//   2. NO browser:execute channel exists (arbitrary IPC execution forbidden).
//   3. Runtime schema validation rejects malformed inputs before handlers run.
//   4. BrowserService / callbacks handle dispatch cleanly.
//   5. Missing service fails closed with HANDLER_ERROR.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { BrowserService } from "../main/browser/browser-service.js";

const VALID_ULID_1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_ULID_2 = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function createMockBrowserService(overrides?: Partial<Record<string, unknown>>) {
  const manager = {
    createSession: vi.fn().mockResolvedValue({
      id: VALID_ULID_1,
      projectId: "proj-1",
      mode: "isolated",
      status: "ready",
      createdAt: new Date().toISOString(),
    }),
    getSession: vi.fn().mockImplementation((id: string) =>
      id === VALID_ULID_1
        ? {
            id: VALID_ULID_1,
            projectId: "proj-1",
            mode: "isolated",
            status: "ready",
            createdAt: new Date().toISOString(),
          }
        : undefined,
    ),
    closeSession: vi.fn().mockResolvedValue(undefined),
    openPage: vi.fn().mockResolvedValue({
      id: VALID_ULID_2,
      contextId: VALID_ULID_1,
      url: "https://example.com",
      title: "Example",
      status: "ready",
    }),
    listPages: vi.fn().mockReturnValue([
      {
        id: VALID_ULID_2,
        contextId: VALID_ULID_1,
        url: "https://example.com",
        title: "Example",
        status: "ready",
      },
    ]),
    getPage: vi.fn().mockImplementation((id: string) =>
      id === VALID_ULID_2
        ? {
            id: VALID_ULID_2,
            contextId: VALID_ULID_1,
            url: "https://example.com",
            title: "Example",
            status: "ready",
          }
        : undefined,
    ),
    closePage: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockReturnValue([{ id: VALID_ULID_1, projectId: "proj-1" }]),
    ...overrides,
  };

  const service = {
    manager,
    getOrCreateSession: vi.fn().mockResolvedValue({
      id: VALID_ULID_1,
      projectId: "proj-1",
      mode: "isolated",
      status: "ready",
      createdAt: new Date().toISOString(),
    }),
    executeAction: vi.fn().mockResolvedValue({
      artifactRef: "/tmp/screenshots/screenshot-1.png",
      bytes: 12345,
    }),
  } as unknown as BrowserService;

  return { service, manager };
}

describe("Browser IPC Channels and Handlers (PR34.5)", () => {
  it("defines all browser channels and explicitly DOES NOT define browser:execute", () => {
    expect(IPC_CHANNELS.BROWSER_SESSION_CREATE).toBe("browser:session-create");
    expect(IPC_CHANNELS.BROWSER_SESSION_GET).toBe("browser:session-get");
    expect(IPC_CHANNELS.BROWSER_SESSION_CLOSE).toBe("browser:session-close");
    expect(IPC_CHANNELS.BROWSER_PAGE_OPEN).toBe("browser:page-open");
    expect(IPC_CHANNELS.BROWSER_PAGE_LIST).toBe("browser:page-list");
    expect(IPC_CHANNELS.BROWSER_PAGE_GET).toBe("browser:page-get");
    expect(IPC_CHANNELS.BROWSER_PAGE_CLOSE).toBe("browser:page-close");
    expect(IPC_CHANNELS.BROWSER_SCREENSHOT).toBe("browser:screenshot");

    expect("BROWSER_EXECUTE" in IPC_CHANNELS).toBe(false);
    expect((Object.values(IPC_CHANNELS) as string[]).includes("browser:execute")).toBe(false);
  });

  describe("Schema validation on bad inputs", () => {
    const registry = new IpcRegistry();
    const { service } = createMockBrowserService();
    registerIpcHandlers(registry, { browserService: service });

    it("fails BROWSER_SESSION_CREATE with empty projectId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_SESSION_CREATE, {
        projectId: "   ",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });

    it("fails BROWSER_SESSION_GET with non-ULID sessionId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_SESSION_GET, {
        sessionId: "invalid-id",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });

    it("fails BROWSER_SESSION_CLOSE with non-ULID sessionId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_SESSION_CLOSE, {
        sessionId: "invalid-id",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });

    it("fails BROWSER_PAGE_GET with non-ULID pageId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_PAGE_GET, {
        pageId: "invalid-id",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });

    it("fails BROWSER_PAGE_CLOSE with non-ULID pageId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_PAGE_CLOSE, {
        pageId: "invalid-id",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });

    it("fails BROWSER_SCREENSHOT with non-ULID pageId", async () => {
      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_SCREENSHOT, {
        pageId: "invalid-id",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Handler dispatch to BrowserService", () => {
    it("creates a browser session via manager", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ session: { id: string } }>(
        IPC_CHANNELS.BROWSER_SESSION_CREATE,
        { projectId: "proj-1", mode: "isolated" },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.session.id).toBe(VALID_ULID_1);
      }
      expect(manager.createSession).toHaveBeenCalledWith({
        projectId: "proj-1",
        mode: "isolated",
      });
    });

    it("gets an existing session and returns null for missing session", async () => {
      const registry = new IpcRegistry();
      const { service } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const found = await registry.invokeCommand<{ session: { id: string } | null }>(
        IPC_CHANNELS.BROWSER_SESSION_GET,
        { sessionId: VALID_ULID_1 },
      );
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.value.session).not.toBeNull();
      }

      const missing = await registry.invokeCommand<{ session: { id: string } | null }>(
        IPC_CHANNELS.BROWSER_SESSION_GET,
        { sessionId: VALID_ULID_2 },
      );
      expect(missing.ok).toBe(true);
      if (missing.ok) {
        expect(missing.value.session).toBeNull();
      }
    });

    it("closes a browser session", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ closed: boolean }>(
        IPC_CHANNELS.BROWSER_SESSION_CLOSE,
        { sessionId: VALID_ULID_1 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.closed).toBe(true);
      }
      expect(manager.closeSession).toHaveBeenCalledWith(VALID_ULID_1);
    });

    it("opens a browser page with existing session", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ page: { id: string } }>(
        IPC_CHANNELS.BROWSER_PAGE_OPEN,
        { sessionId: VALID_ULID_1, url: "https://example.com", name: "tab-1" },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.page.id).toBe(VALID_ULID_2);
      }
      expect(manager.openPage).toHaveBeenCalledWith(VALID_ULID_1, {
        url: "https://example.com",
        name: "tab-1",
      });
    });

    it("opens a browser page with auto-created session when sessionId omitted", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ page: { id: string } }>(
        IPC_CHANNELS.BROWSER_PAGE_OPEN,
        { projectId: "proj-1", url: "https://example.com" },
      );
      expect(res.ok).toBe(true);
      expect(service.getOrCreateSession).toHaveBeenCalledWith("proj-1");
      expect(manager.openPage).toHaveBeenCalledWith(VALID_ULID_1, {
        url: "https://example.com",
      });
    });

    it("lists browser pages", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ pages: Array<{ id: string }> }>(
        IPC_CHANNELS.BROWSER_PAGE_LIST,
        {},
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.pages).toHaveLength(1);
        expect(res.value.pages[0].id).toBe(VALID_ULID_2);
      }
      expect(manager.listPages).toHaveBeenCalled();
    });

    it("gets browser page by id", async () => {
      const registry = new IpcRegistry();
      const { service } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ page: { id: string } | null }>(
        IPC_CHANNELS.BROWSER_PAGE_GET,
        { pageId: VALID_ULID_2 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.page?.id).toBe(VALID_ULID_2);
      }
    });

    it("closes browser page by id", async () => {
      const registry = new IpcRegistry();
      const { service, manager } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{ closed: boolean }>(
        IPC_CHANNELS.BROWSER_PAGE_CLOSE,
        { pageId: VALID_ULID_2 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.closed).toBe(true);
      }
      expect(manager.closePage).toHaveBeenCalledWith(VALID_ULID_2);
    });

    it("captures screenshot via executeAction", async () => {
      const registry = new IpcRegistry();
      const { service } = createMockBrowserService();
      registerIpcHandlers(registry, { browserService: service });

      const res = await registry.invokeCommand<{
        screenshot: { artifactRef: string; bytes: number };
      }>(IPC_CHANNELS.BROWSER_SCREENSHOT, { pageId: VALID_ULID_2, fullPage: true });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.screenshot.artifactRef).toBe("/tmp/screenshots/screenshot-1.png");
        expect(res.value.screenshot.bytes).toBe(12345);
      }
      expect(service.executeAction).toHaveBeenCalledWith(
        "screenshot",
        { pageId: VALID_ULID_2, fullPage: true },
        expect.objectContaining({ projectId: "default" }),
      );
    });
  });

  describe("Callback overrides", () => {
    it("routes to callbacks when provided", async () => {
      const registry = new IpcRegistry();
      const onBrowserSessionCreate = vi.fn().mockResolvedValue({
        session: { id: "custom-session" },
      });
      registerIpcHandlers(registry, {
        callbacks: {
          onBrowserSessionCreate,
        },
      });

      const res = await registry.invokeCommand<{ session: { id: string } }>(
        IPC_CHANNELS.BROWSER_SESSION_CREATE,
        { projectId: "proj-1" },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.session.id).toBe("custom-session");
      }
      expect(onBrowserSessionCreate).toHaveBeenCalled();
    });
  });

  describe("Fail-closed when BrowserService is missing", () => {
    it("returns HANDLER_ERROR if browserService is not registered", async () => {
      const registry = new IpcRegistry();
      registerIpcHandlers(registry, {});

      const res = await registry.invokeCommand(IPC_CHANNELS.BROWSER_SESSION_CREATE, {
        projectId: "proj-1",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("HANDLER_ERROR");
        expect(res.error.message).toContain("BrowserService is not available");
      }
    });
  });
});
