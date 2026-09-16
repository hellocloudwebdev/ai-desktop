// PR39: apps/desktop — Attachments IPC Module (thin handlers, no new service)
//
// Thin handlers over MediaArtifactStore (bytes) + PrismaAttachmentRepository
// (metadata). Mirrors the documents:* handler pattern in main/ipc/index.ts:
// no PermissionManager call in IPC (tools enforce permissions); Zod schemas
// in @ai-desktop/shared validate before any handler runs.
//
// Security posture:
//   - Bytes live main-side only; renderer receives metadata + a bounded
//     image-only thumbnail (max 200KB). Audio/video previews return a
//     metadata card without bytes. There is intentionally NO read-path
//     channel — the renderer never receives filesystem paths.
//   - Error messages carry codes + short reasons only (no base64/bytes).

import { createHash } from "node:crypto";
import {
  ATTACHMENTS_PREVIEW_MAX_BYTES,
  type AttachmentsDeleteCommand,
  type AttachmentsGetCommand,
  type AttachmentsListCommand,
  type AttachmentsPreviewCommand,
  type AttachmentsUploadCommand,
} from "@ai-desktop/shared";
import { createAttachmentId } from "@ai-desktop/ai-core";
import type { AttachmentRepository, StoredAttachment } from "@ai-desktop/storage";
import {
  MediaArtifactError,
  MediaArtifactStore,
  type ArtifactMetadata,
} from "./media-artifacts.js";

export interface AttachmentView {
  readonly attachmentId: string;
  readonly projectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly status: string;
  readonly artifactId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AttachmentPreviewView =
  | { readonly kind: "image"; readonly mimeType: string; readonly dataBase64: string }
  | { readonly kind: "card"; readonly metadata: AttachmentView };

export interface AttachmentsIpcDependencies {
  readonly artifactStore: MediaArtifactStore;
  readonly attachmentRepository: AttachmentRepository;
}

function toView(stored: StoredAttachment): AttachmentView {
  return {
    attachmentId: stored.attachmentId,
    projectId: stored.projectId,
    filename: stored.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    status: stored.status,
    artifactId: stored.artifactId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/**
 * Fail-closed metadata fetch: unknown ids and cross-project access both
 * surface as not-found (no project-existence oracle, no path leakage).
 */
async function getScopedAttachment(
  deps: AttachmentsIpcDependencies,
  projectId: string,
  attachmentId: string,
): Promise<StoredAttachment> {
  const stored = await deps.attachmentRepository.getAttachmentById(attachmentId);
  if (!stored || stored.projectId !== projectId) {
    throw new MediaArtifactError("ATTACHMENT_NOT_FOUND", "Unknown attachment");
  }
  return stored;
}

export async function listAttachments(
  deps: AttachmentsIpcDependencies,
  input: AttachmentsListCommand,
): Promise<{ attachments: AttachmentView[] }> {
  const rows = await deps.attachmentRepository.listAttachmentsByProject(input.projectId);
  return { attachments: rows.map(toView) };
}

export async function getAttachment(
  deps: AttachmentsIpcDependencies,
  input: AttachmentsGetCommand,
): Promise<{ attachment: AttachmentView }> {
  const stored = await getScopedAttachment(deps, input.projectId, input.attachmentId);
  return { attachment: toView(stored) };
}

export async function uploadAttachment(
  deps: AttachmentsIpcDependencies,
  input: AttachmentsUploadCommand,
): Promise<{ attachment: AttachmentView }> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
  } catch {
    throw new MediaArtifactError("INVALID_MEDIA", "Upload payload is not valid base64");
  }
  // store.save re-checks the allowlist, byte bounds, and image magic bytes.
  const saved = await deps.artifactStore.save({
    projectId: input.projectId,
    filename: input.fileName,
    mimeType: input.mimeType,
    bytes,
  });
  const attachmentId = createAttachmentId();
  const nowMs = Date.now();
  const stored = await deps.attachmentRepository.createAttachment({
    attachmentId,
    projectId: input.projectId,
    filename: input.fileName.slice(0, 255),
    mimeType: input.mimeType,
    sizeBytes: saved.sizeBytes,
    checksumSha256: saved.checksumSha256,
    status: "available",
    artifactId: saved.artifactId,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  return { attachment: toView(stored) };
}

export async function deleteAttachment(
  deps: AttachmentsIpcDependencies,
  input: AttachmentsDeleteCommand,
): Promise<{ deleted: boolean }> {
  const stored = await getScopedAttachment(deps, input.projectId, input.attachmentId);
  // Bytes first (idempotent), then metadata. Cross-project ids fail above.
  await deps.artifactStore.delete(input.projectId, stored.artifactId);
  await deps.attachmentRepository.deleteAttachment(input.attachmentId, input.projectId);
  return { deleted: true };
}

export async function previewAttachment(
  deps: AttachmentsIpcDependencies,
  input: AttachmentsPreviewCommand,
): Promise<{ preview: AttachmentPreviewView }> {
  const stored = await getScopedAttachment(deps, input.projectId, input.attachmentId);
  const view = toView(stored);
  if (!stored.mimeType.toLowerCase().startsWith("image/")) {
    // Audio/video/non-image: metadata card, no bytes cross IPC.
    return { preview: { kind: "card", metadata: view } };
  }
  let meta: ArtifactMetadata;
  try {
    meta = await deps.artifactStore.getMetadata(input.projectId, stored.artifactId);
  } catch {
    throw new MediaArtifactError("ATTACHMENT_NOT_FOUND", "Unknown attachment");
  }
  const cap = Math.min(
    input.maxBytes ?? ATTACHMENTS_PREVIEW_MAX_BYTES,
    ATTACHMENTS_PREVIEW_MAX_BYTES,
  );
  if (meta.sizeBytes > cap) {
    throw new MediaArtifactError(
      "PREVIEW_TOO_LARGE",
      `Image preview exceeds ${cap} bytes; open the attachment instead`,
    );
  }
  const loaded = await deps.artifactStore.load(input.projectId, stored.artifactId);
  const digest = createHash("sha256").update(loaded.bytes).digest("hex");
  if (digest !== meta.checksumSha256) {
    throw new MediaArtifactError("INVALID_MEDIA", "Attachment integrity check failed");
  }
  return {
    preview: {
      kind: "image",
      mimeType: loaded.mimeType,
      dataBase64: Buffer.from(loaded.bytes).toString("base64"),
    },
  };
}
