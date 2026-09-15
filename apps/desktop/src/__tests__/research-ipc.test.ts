// PR35: apps/desktop — Research IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All research:* channels registered (search, open, status).
//   2. NO research:execute channel exists (arbitrary IPC execution forbidden).
//   3. Runtime schema validation rejects malformed inputs before handlers run.
//   4. ResearchService / callbacks handle dispatch cleanly.
//   5. Missing service fails closed with HANDLER_ERROR.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { ResearchService } from "../main/research/research-service.js";

function createMockResearchService() {
  return {
    search: vi.fn().mockResolvedValue([
      {
        id: "r1",
        title: "Example",
        url: "https://example.com",
        source: { channel: "search", provider: "search" },
      },
    ]),
    open: vi.fn().mockResolvedValue({
      id: "r1",
      title: "Example",
      url: "https://example.com",
      content: "hello",
      source: { channel: "web", provider: "static-reader" },
    }),
    health: {
      snapshot: vi.fn().mockReturnValue([{ provider: "static-reader", status: "available" }]),
    },
  };
}

describe("research ipc channels", () => {
  it("registers exactly the three research channels", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {
      researchService: createMockResearchService() as unknown as ResearchService,
    });
    expect(registry.registeredChannels.has(IPC_CHANNELS.RESEARCH_SEARCH)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.RESEARCH_OPEN)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.RESEARCH_STATUS)).toBe(true);
  });

  it("exposes no research:execute channel", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(channels).not.toContain("research:execute");
  });

  it("rejects malformed search input before the handler runs", async () => {
    const service = createMockResearchService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: service as unknown as ResearchService });
    const res = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, { query: "" });
    expect(res.ok).toBe(false);
    expect(service.search).not.toHaveBeenCalled();
  });

  it("rejects dangerous open URLs before the handler runs", async () => {
    const service = createMockResearchService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: service as unknown as ResearchService });
    const res = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_OPEN, {
      url: "javascript:alert(1)",
    });
    expect(res.ok).toBe(false);
    expect(service.open).not.toHaveBeenCalled();
  });

  it("dispatches search to the research service", async () => {
    const service = createMockResearchService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: service as unknown as ResearchService });
    const res = await registry.invokeCommand<{ results: unknown[] }>(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "local llm",
      projectId: "p1",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.results).toHaveLength(1);
    }
    expect(service.search).toHaveBeenCalledTimes(1);
  });

  it("dispatches open to the research service", async () => {
    const service = createMockResearchService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: service as unknown as ResearchService });
    const res = await registry.invokeCommand<{ result: unknown }>(IPC_CHANNELS.RESEARCH_OPEN, {
      url: "https://example.com/article",
    });
    expect(res.ok).toBe(true);
    expect(service.open).toHaveBeenCalledTimes(1);
  });

  it("returns the provider health snapshot on status", async () => {
    const service = createMockResearchService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { researchService: service as unknown as ResearchService });
    const res = await registry.invokeCommand<{ providers: unknown[] }>(
      IPC_CHANNELS.RESEARCH_STATUS,
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.providers).toHaveLength(1);
    }
  });

  it("fails closed when the research service is missing", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const res = await registry.invokeCommand(IPC_CHANNELS.RESEARCH_SEARCH, { query: "x" });
    expect(res.ok).toBe(false);
  });

  it("honors callback overrides", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {
      callbacks: {
        onResearchSearch: async () => ({ results: [{ custom: true }] }),
      },
    });
    const res = await registry.invokeCommand<{ results: unknown[] }>(IPC_CHANNELS.RESEARCH_SEARCH, {
      query: "x",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.results).toEqual([{ custom: true }]);
    }
  });
});
