// PR39: apps/desktop — Project-Scoped Media Artifact Store
//
// Filesystem-backed binary store for chat attachments. Bytes live under
// <rootDir>/<projectId>/<artifactId>.<ext>; metadata rides in a JSON
// sidecar. Events/IPC/preload carry references (artifactId), never bytes.
// Every access re-validates project scope; paths resolve through the
// workspace path-policy (symlink-escape rejection).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BaseError } from "@ai-desktop/shared";
import {
  createMediaArtifactId,
  isSupportedAttachmentMimeType,
  MULTIMEDIA_MAX_ATTACHMENT_BYTES,
  type MediaArtifactId,
} from "@ai-desktop/ai-core";
import { resolveWorkspacePath } from "../agent/filesystem/path-policy.js";

export const MEDIA_PROJECT_QUOTA_BYTES = 524288000;

/**
 * PR39: decompression-bomb ceiling. Declared PNG dimensions whose pixel
 * count exceeds this are rejected before any decode (minimal IHDR parse,
 * no image library involved).
 */
export const MAX_IMAGE_PIXELS = 67_000_000;

function bytesStartWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((b, i) => bytes[i] === b);
}

function bytesAsciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * PR39: validates image/* magic bytes against the declared MIME type and
 * rejects decompression bombs via a minimal PNG IHDR dimension parse.
 * Declared-type based: EXE bytes labelled image/png are rejected; only
 * metadata-bearing error messages are produced (never byte content).
 */
export function checkImageMagic(mimeType: string, bytes: Uint8Array): void {
  const fail = (): never => {
    throw new MediaArtifactError("INVALID_MEDIA", `Image bytes do not match "${mimeType}"`);
  };
  switch (mimeType) {
    case "image/png": {
      if (!bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        fail();
      }
      // Minimal IHDR parse: signature(8) + length(4) + "IHDR"(4) + width(4BE) + height(4BE).
      if (bytes.length >= 24 && bytesAsciiAt(bytes, 12, "IHDR")) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = view.getUint32(16);
        const height = view.getUint32(20);
        if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
          throw new MediaArtifactError(
            "INVALID_MEDIA",
            "Image dimensions exceed the supported pixel bound",
          );
        }
      }
      return;
    }
    case "image/jpeg": {
      if (!bytesStartWith(bytes, [0xff, 0xd8, 0xff])) {
        fail();
      }
      return;
    }
    case "image/gif": {
      if (!bytesAsciiAt(bytes, 0, "GIF87a") && !bytesAsciiAt(bytes, 0, "GIF89a")) {
        fail();
      }
      return;
    }
    case "image/webp": {
      if (!bytesAsciiAt(bytes, 0, "RIFF") || !bytesAsciiAt(bytes, 8, "WEBP")) {
        fail();
      }
      return;
    }
    default:
      return;
  }
}

export class MediaArtifactError extends BaseError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MediaArtifactError";
  }
}

export interface SaveArtifactInput {
  readonly projectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface SavedArtifact {
  readonly artifactId: MediaArtifactId;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

export interface LoadedArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
}

export interface ArtifactMetadata {
  readonly artifactId: MediaArtifactId;
  readonly projectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly createdAt: string;
}

const ARTIFACT_ID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

export class MediaArtifactStore {
  private readonly _rootDir: string;
  private readonly _maxBytes: number;

  constructor(opts: { rootDir: string; maxBytes?: number }) {
    this._rootDir = opts.rootDir;
    this._maxBytes = opts.maxBytes ?? MULTIMEDIA_MAX_ATTACHMENT_BYTES;
  }

  private _projectDir(projectId: string): string {
    if (!projectId || projectId.includes("..") || path.isAbsolute(projectId)) {
      throw new MediaArtifactError("PROJECT_MISMATCH", "Invalid project id");
    }
    const resolved = resolveWorkspacePath(this._rootDir, projectId);
    return resolved.targetReal;
  }

  private _artifactPaths(projectId: string, artifactId: string): { bin: string; meta: string } {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new MediaArtifactError("ARTIFACT_NOT_FOUND", "Unknown artifact");
    }
    const dir = this._projectDir(projectId);
    return {
      bin: path.join(dir, `${artifactId}.bin`),
      meta: path.join(dir, `${artifactId}.json`),
    };
  }

  async save(input: SaveArtifactInput): Promise<SavedArtifact> {
    if (input.signal?.aborted) {
      throw new MediaArtifactError("CANCELLED", "Artifact save cancelled");
    }
    if (!isSupportedAttachmentMimeType(input.mimeType.toLowerCase())) {
      throw new MediaArtifactError(
        "UNSUPPORTED_MEDIA_TYPE",
        `MIME type not allowed: "${input.mimeType}"`,
      );
    }
    if (input.bytes.length > this._maxBytes) {
      throw new MediaArtifactError("MEDIA_TOO_LARGE", `Artifact exceeds ${this._maxBytes} bytes`);
    }
    const normalizedMime = input.mimeType.toLowerCase();
    if (normalizedMime.startsWith("image/")) {
      // Declared-type magic check: EXE-as-PNG and decompression bombs fail here.
      checkImageMagic(normalizedMime, input.bytes);
    }
    const dir = this._projectDir(input.projectId);
    await fs.promises.mkdir(dir, { recursive: true });
    const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const artifactId = createMediaArtifactId();
    const meta: ArtifactMetadata = {
      artifactId,
      projectId: input.projectId,
      filename: path.basename(input.filename).slice(0, 255),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      checksumSha256,
      createdAt: new Date().toISOString(),
    };
    const { bin, meta: metaPath } = this._artifactPaths(input.projectId, artifactId);
    if (input.signal?.aborted) {
      throw new MediaArtifactError("CANCELLED", "Artifact save cancelled");
    }
    await fs.promises.writeFile(bin, input.bytes);
    await fs.promises.writeFile(metaPath, JSON.stringify(meta));
    return { artifactId, checksumSha256, sizeBytes: input.bytes.length };
  }

  async load(projectId: string, artifactId: string): Promise<LoadedArtifact> {
    const { bin, meta: metaPath } = this._artifactPaths(projectId, artifactId);
    let meta: ArtifactMetadata;
    try {
      meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8")) as ArtifactMetadata;
    } catch {
      throw new MediaArtifactError("ARTIFACT_NOT_FOUND", "Unknown artifact");
    }
    if (meta.projectId !== projectId) {
      throw new MediaArtifactError("PROJECT_MISMATCH", "Artifact belongs to another project");
    }
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(bin);
    } catch {
      throw new MediaArtifactError("ARTIFACT_DELETED", "Artifact bytes unavailable");
    }
    return { bytes: new Uint8Array(bytes), mimeType: meta.mimeType, filename: meta.filename };
  }

  async getMetadata(projectId: string, artifactId: string): Promise<ArtifactMetadata> {
    const { meta: metaPath } = this._artifactPaths(projectId, artifactId);
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8")) as ArtifactMetadata;
      if (meta.projectId !== projectId) {
        throw new MediaArtifactError("PROJECT_MISMATCH", "Artifact belongs to another project");
      }
      return meta;
    } catch (err) {
      if (err instanceof MediaArtifactError) {
        throw err;
      }
      throw new MediaArtifactError("ARTIFACT_NOT_FOUND", "Unknown artifact");
    }
  }

  async delete(projectId: string, artifactId: string): Promise<void> {
    let paths: { bin: string; meta: string };
    try {
      paths = this._artifactPaths(projectId, artifactId);
    } catch {
      return;
    }
    const meta = await this.getMetadata(projectId, artifactId).catch(() => undefined);
    if (!meta) {
      return;
    }
    await fs.promises.rm(paths.bin, { force: true });
    await fs.promises.rm(paths.meta, { force: true });
  }
}
