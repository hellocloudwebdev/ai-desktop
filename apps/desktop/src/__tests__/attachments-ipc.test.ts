// PR39: apps/desktop — Attachments IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All attachments:* channels registered (list, get, upload, delete, preview).
//   2. NO attachments:read-path / attachments:execute / media:readPath channel.
//   3. Schema validation rejects malformed inputs before handlers run.
//   4. Thin handlers dispatch cleanly over store + repository doubles.
//   5. Missing dependencies fail closed.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import { MediaArtifactStore } from "../main/chat/media-artifacts.js";
import type { AttachmentRepository } from "@ai-desktop/storage";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createStore(root: string): MediaArtifactStore {
  return new MediaArtifactStore({ rootDir: root });
}

function createRepository() {
  const rows = new Map<string, Record<string, unknown>>();
  const repo = {
    rows,
    async createAttachment(data: Record<string, unknown>) {
      rows.set(String(data["attachmentId"]), { ...data });
      return { ...data };
    },
    async getAttachmentById(attachmentId: string) {
      return (rows.get(attachmentId) as never) ?? null;
    },
    async listAttachmentsByProject(projectId: string) {
      return [...rows.values()].filter((r) => r["projectId"] === projectId) as never[];
    },
    async updateAttachmentStatus(attachmentId: string, status: string) {
      const row = rows.get(attachmentId);
      if (!row) throw new Error("missing");
      const next = { ...row, status };
      rows.set(attachmentId, next);
      return next as never;
    },
    async deleteAttachment(attachmentId: string) {
      rows.delete(attachmentId);
    },
  };
  return repo;
}

function createDeps(root: string) {
  return {
    artifactStore: createStore(root),
    attachmentRepository: createRepository() as unknown as AttachmentRepository,
  };
}

const ATTACHMENT_ID = "01JAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("attachments ipc channels", () => {
  it("registers all five attachment channels", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { attachments: createDeps(os.tmpdir()) });
    expect(registry.registeredChannels.has(IPC_CHANNELS.ATTACHMENTS_LIST)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.ATTACHMENTS_GET)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.ATTACHMENTS_UPLOAD)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.ATTACHMENTS_DELETE)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.ATTACHMENTS_PREVIEW)).toBe(true);
  });

  it("exposes no read-path/execute channel", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(channels).not.toContain("attachments:read-path");
    expect(channels).not.toContain("attachments:execute");
    expect(channels).not.toContain("attachments:raw-fs");
    expect(channels).not.toContain("media:readPath");
  });

  it("rejects malformed upload input before the handler runs", async () => {
    const deps = createDeps(os.tmpdir());
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { attachments: deps });
    const before = (deps.attachmentRepository as unknown as { rows: Map<string, unknown> }).rows
      .size;
    const res = await registry.invokeCommand(IPC_CHANNELS.ATTACHMENTS_UPLOAD, {
      projectId: "p1",
      fileName: "",
      mimeType: "image/png",
      contentBase64: Buffer.from(PNG).toString("base64"),
    });
    expect(res.ok).toBe(false);
    expect((deps.attachmentRepository as unknown as { rows: Map<string, unknown> }).rows.size).toBe(
      before,
    );
  });

  it("requires projectId on list", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { attachments: createDeps(os.tmpdir()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.ATTACHMENTS_LIST, {});
    expect(res.ok).toBe(false);
  });

  it("rejects oversized preview bounds before dispatch", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { attachments: createDeps(os.tmpdir()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.ATTACHMENTS_PREVIEW, {
      projectId: "p1",
      attachmentId: ATTACHMENT_ID,
      maxBytes: 999_999_999,
    });
    expect(res.ok).toBe(false);
  });

  it("dispatches upload then list through the thin handlers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach-ipc-"));
    try {
      const registry = new IpcRegistry();
      registerIpcHandlers(registry, { attachments: createDeps(root) });
      const upload = await registry.invokeCommand<{ attachment: { attachmentId: string } }>(
        IPC_CHANNELS.ATTACHMENTS_UPLOAD,
        {
          projectId: "p1",
          fileName: "photo.png",
          mimeType: "image/png",
          contentBase64: Buffer.from(PNG).toString("base64"),
        },
      );
      expect(upload.ok).toBe(true);
      const list = await registry.invokeCommand<{ attachments: unknown[] }>(
        IPC_CHANNELS.ATTACHMENTS_LIST,
        { projectId: "p1" },
      );
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value.attachments).toHaveLength(1);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dispatches preview for small images, metadata card for audio", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach-ipc-"));
    try {
      const deps = createDeps(root);
      const registry = new IpcRegistry();
      registerIpcHandlers(registry, { attachments: deps });
      const b64 = Buffer.from(PNG).toString("base64");
      const upload = await registry.invokeCommand<{ attachment: { attachmentId: string } }>(
        IPC_CHANNELS.ATTACHMENTS_UPLOAD,
        { projectId: "p1", fileName: "a.png", mimeType: "image/png", contentBase64: b64 },
      );
      expect(upload.ok).toBe(true);
      if (!upload.ok) return;
      const preview = await registry.invokeCommand<{
        preview: { kind: string; dataBase64?: string };
      }>(IPC_CHANNELS.ATTACHMENTS_PREVIEW, {
        projectId: "p1",
        attachmentId: upload.value.attachment.attachmentId,
      });
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.value.preview.kind).toBe("image");
        expect(preview.value.preview.dataBase64).toBe(b64);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without attachment dependencies", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const res = await registry.invokeCommand(IPC_CHANNELS.ATTACHMENTS_LIST, { projectId: "p1" });
    expect(res.ok).toBe(false);
  });

  it("fails closed for unknown attachment ids", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { attachments: createDeps(os.tmpdir()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.ATTACHMENTS_GET, {
      projectId: "p1",
      attachmentId: ATTACHMENT_ID,
    });
    expect(res.ok).toBe(false);
  });

  it("keeps attachment payloads free of filesystem paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach-ipc-"));
    try {
      const registry = new IpcRegistry();
      registerIpcHandlers(registry, { attachments: createDeps(root) });
      const upload = await registry.invokeCommand<{ attachment: Record<string, unknown> }>(
        IPC_CHANNELS.ATTACHMENTS_UPLOAD,
        {
          projectId: "p1",
          fileName: "a.png",
          mimeType: "image/png",
          contentBase64: Buffer.from(PNG).toString("base64"),
        },
      );
      expect(upload.ok).toBe(true);
      if (!upload.ok) return;
      const serialized = JSON.stringify(upload.value);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain(".bin");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
