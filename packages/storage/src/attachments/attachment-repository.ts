// PR39: packages/storage — AttachmentRepository Interface
//
// Storage abstraction for attachment metadata (never bytes — those live in
// the desktop MediaArtifactStore). Status lifecycle enforced by callers.

export interface StoredAttachment {
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

export interface CreateAttachmentData {
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

export interface AttachmentRepository {
  createAttachment(data: CreateAttachmentData): Promise<StoredAttachment>;
  getAttachmentById(attachmentId: string): Promise<StoredAttachment | null>;
  listAttachmentsByProject(projectId: string): Promise<StoredAttachment[]>;
  updateAttachmentStatus(attachmentId: string, status: string): Promise<StoredAttachment>;
  deleteAttachment(attachmentId: string, projectId: string): Promise<void>;
}
