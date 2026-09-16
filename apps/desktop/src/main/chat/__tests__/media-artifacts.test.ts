// PR39: apps/desktop — Media Artifact Store Tests
//
// Covers save/load/metadata/delete, project isolation, traversal rejection,
// MIME allowlist, oversize, idempotent delete/cancel. Uses a tmp root dir.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaArtifactStore } from "../media-artifacts.js";

let root: string;
let store: MediaArtifactStore;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-"));
  store = new MediaArtifactStore({ rootDir: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("MediaArtifactStore", () => {
  it("saves and loads bytes with metadata", async () => {
    const saved = await store.save({
      projectId: "p1",
      filename: "photo.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    expect(saved.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await store.load("p1", saved.artifactId);
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(loaded.mimeType).toBe("image/png");
    const meta = await store.getMetadata("p1", saved.artifactId);
    expect(meta.filename).toBe("photo.png");
    expect(meta.sizeBytes).toBe(PNG.length);
  });

  it("isolates projects", async () => {
    const saved = await store.save({
      projectId: "pA",
      filename: "a.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    await expect(store.load("pB", saved.artifactId)).rejects.toThrow();
    await expect(store.getMetadata("pB", saved.artifactId)).rejects.toThrow();
  });

  it("rejects traversal project ids", async () => {
    await expect(
      store.save({ projectId: "../evil", filename: "x.png", mimeType: "image/png", bytes: PNG }),
    ).rejects.toThrow();
    await expect(
      store.save({
        projectId: "/absolute",
        filename: "x.png",
        mimeType: "image/png",
        bytes: PNG,
      }),
    ).rejects.toThrow();
  });

  it("rejects disallowed MIME types", async () => {
    await expect(
      store.save({
        projectId: "p1",
        filename: "evil.exe",
        mimeType: "application/x-msdownload",
        bytes: enc("x"),
      }),
    ).rejects.toThrow(/MIME|unsupported/i);
  });

  it("rejects oversized payloads", async () => {
    const small = new MediaArtifactStore({ rootDir: root, maxBytes: 4 });
    await expect(
      small.save({ projectId: "p1", filename: "a.png", mimeType: "image/png", bytes: PNG }),
    ).rejects.toThrow(/exceed|large|size|limit/i);
  });

  it("deletes idempotently", async () => {
    const saved = await store.save({
      projectId: "p1",
      filename: "a.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    await store.delete("p1", saved.artifactId);
    await expect(store.load("p1", saved.artifactId)).rejects.toThrow();
    await store.delete("p1", saved.artifactId);
    await store.delete("p1", "01JAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("rejects malformed artifact ids", async () => {
    await expect(store.load("p1", "not-an-id")).rejects.toThrow();
    await expect(store.load("p1", "../../etc/passwd")).rejects.toThrow();
  });

  it("cancels save on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.save({
        projectId: "p1",
        filename: "a.png",
        mimeType: "image/png",
        bytes: PNG,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/i);
    controller.abort();
  });

  it("never stores bytes outside the project dir", async () => {
    const saved = await store.save({
      projectId: "p1",
      filename: "a.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBe(2);
    for (const file of files) {
      expect(file.startsWith(path.join(root, "p1"))).toBe(true);
    }
    expect(saved.artifactId).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i);
  });
});
