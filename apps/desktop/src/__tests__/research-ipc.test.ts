// PR35.26/35.30: apps/desktop — Research IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. research:search and research:open channels registered.
//   2. NO research:execute channel exists (arbitrary IPC execution forbidden;
//      execution flows through the agent tool router).
//   3. Zod validation rejects malformed inputs before handlers run.
//   4. Missing service fails closed with HANDLER_ERROR.
//   5. Handlers delegate to ResearchService with projectId propagation.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { ResearchService } from "../main/research/research-service.js";

function createMockResearchService() {
  const service = {
    searchWeb: vi.fn().mockResolvedValue({
      id: "01J00000000000000000000001",
      title: "Search: x",
      source: { provider: "exa", channel: "search" },
    }),
    openWebPage: vi.fn().mockResolvedValue({
      id: "01J00000000000000000000002",
      title: "Page",
      source: { provider: "static-reader", channel: "web" },
    }),
  } as unknown as ResearchService;
  return service;
}

describe("Research IPC Channels and Handlers (PR35.26)", () => {
  it("defines research channels and explicitly DOES NOT define research:execute", () => {
    expect(IPC_CHANNELS.RESEARCH_SEARCH).toBe("research:search");
    expect(IPC_CHANNELS.RESEARCH_OPEN).toBe("research:open");

    expect("RESEARCH_EXECUTE" in IPC_CHANNELS).toBe(false);
    expect((Object.values(IPC_CHANNELS) as string[]).includes("research:execute")).toBe(false);
  });

  it("rejects malformed inputs before handlers run", async () => {
    const registry = new IpcRegistry();
    const service = createMockResearchService();
    registerIpcHandlers(registry, { researchService: service });

    const emptyQuery = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "",
    });
    expect(emptyQuery.ok).toBe(false);

    const missingUrl = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_OPEN, {});
    expect(missingUrl.ok).toBe(false);

    const oversized = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "x".repeat(501),
    });
    expect(oversized.ok).toBe(false);

    expect(service.searchWeb).not.toHaveBeenCalled();
    expect(service.openWebPage).not.toHaveBeenCalled();
  });

  it("dispatches to ResearchService with projectId propagation", async () => {
    const registry = new IpcRegistry();
    const service = createMockResearchService();
    registerIpcHandlers(registry, { researchService: service });

    const search = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "local llm",
      projectId: "proj-1",
    });
    expect(search.ok).toBe(true);
    expect(service.searchWeb).toHaveBeenCalledWith("local llm", { projectId: "proj-1" });

    const open = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_OPEN, {
      url: "https://example.com/a",
      projectId: "proj-1",
    });
    expect(open.ok).toBe(true);
    expect(service.openWebPage).toHaveBeenCalledWith("https://example.com/a", {
      projectId: "proj-1",
    });
  });

  it("fails closed when ResearchService is unavailable", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const search = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "x",
    });
    expect(search.ok).toBe(false);
    const open = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_OPEN, {
      url: "https://example.com/a",
    });
    expect(open.ok).toBe(false);
  });

  it("rejects unknown channels (no collision, no silent pass-through)", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: createMockResearchService() });
    await expect(
      registry.invokeCommand("research:execute" as never, { anything: true }),
    ).rejects.toThrow();
  });
});
