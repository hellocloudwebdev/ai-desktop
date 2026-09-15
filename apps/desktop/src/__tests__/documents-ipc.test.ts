// PR37: apps/desktop — Documents IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All documents:* channels registered (list, get, search, ingest, delete).
//   2. NO documents:execute / documents:read-path / documents:raw-fs channel.
//   3. Schema validation rejects malformed inputs before handlers run.
//   4. DocumentService handles dispatch cleanly.
//   5. Missing service fails closed.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { DocumentService } from "../main/documents/document-service.js";

function createMockDocumentService() {
  return {
    list: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({
      document: { documentId: "d1", name: "a.txt", status: "ready" },
      text: "hello",
      chunks: 1,
      framed: "framed",
    }),
    search: vi.fn().mockResolvedValue({ query: "q", matches: [], searchedAt: "", totalChunks: 0 }),
    ingest: vi.fn().mockResolvedValue({ documentId: "d1", status: "ready", chunksCreated: 1 }),
    remove: vi.fn().mockResolvedValue({ documentId: "d1", projectId: "p1" }),
  };
}

describe("documents ipc channels", () => {
  it("registers all five document channels", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {
      documentService: createMockDocumentService() as unknown as DocumentService,
    });
    expect(registry.registeredChannels.has(IPC_CHANNELS.DOCUMENTS_LIST)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.DOCUMENTS_GET)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.DOCUMENTS_SEARCH)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.DOCUMENTS_INGEST)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.DOCUMENTS_DELETE)).toBe(true);
  });

  it("exposes no execute/read-path/raw-fs channel", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(channels).not.toContain("documents:execute");
    expect(channels).not.toContain("documents:read-path");
    expect(channels).not.toContain("documents:raw-fs");
  });

  it("rejects malformed search input before the handler runs", async () => {
    const service = createMockDocumentService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { documentService: service as unknown as DocumentService });
    const res = await registry.invokeCommand(IPC_CHANNELS.DOCUMENTS_SEARCH, {
      projectId: "p1",
      query: "",
    });
    expect(res.ok).toBe(false);
    expect(service.search).not.toHaveBeenCalled();
  });

  it("requires projectId on list", async () => {
    const service = createMockDocumentService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { documentService: service as unknown as DocumentService });
    const res = await registry.invokeCommand(IPC_CHANNELS.DOCUMENTS_LIST, {});
    expect(res.ok).toBe(false);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("dispatches search to the document service", async () => {
    const service = createMockDocumentService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { documentService: service as unknown as DocumentService });
    const res = await registry.invokeCommand<{ result: { query: string } }>(
      IPC_CHANNELS.DOCUMENTS_SEARCH,
      { projectId: "p1", query: "auth", limit: 5 },
    );
    expect(res.ok).toBe(true);
    expect(service.search).toHaveBeenCalledWith({ projectId: "p1", query: "auth", limit: 5 });
  });

  it("decodes base64 ingest payloads to bytes", async () => {
    const service = createMockDocumentService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { documentService: service as unknown as DocumentService });
    const bytes = Buffer.from("hello world", "utf-8").toString("base64");
    const res = await registry.invokeCommand(IPC_CHANNELS.DOCUMENTS_INGEST, {
      projectId: "p1",
      fileName: "a.txt",
      mimeType: "text/plain",
      contentBase64: bytes,
    });
    expect(res.ok).toBe(true);
    const call = service.ingest.mock.calls[0]?.[0] as { bytes: Uint8Array };
    expect(Buffer.from(call.bytes).toString("utf-8")).toBe("hello world");
  });

  it("fails closed without a document service", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const res = await registry.invokeCommand(IPC_CHANNELS.DOCUMENTS_LIST, { projectId: "p1" });
    expect(res.ok).toBe(false);
  });
});
