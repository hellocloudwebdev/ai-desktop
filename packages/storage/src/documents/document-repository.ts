// PR37: packages/storage — DocumentRepository Interface
//
// Storage abstraction for durable document metadata and chunk texts.
//   - Zero Prisma imports outside packages/storage.
//   - Retrieval is in-memory in the desktop service; storage only persists.
//   - Raw document bytes are never stored, only metadata + normalized chunks.
//   - Status lifecycle is enforced by callers via VALID_DOCUMENT_TRANSITIONS;
//     this interface persists whatever status it is given.

export interface StoredDocument {
  readonly documentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly status: string;
  readonly sourceType: string;
  readonly sourceFileName: string;
  readonly sourceFileSize: number;
  readonly title: string | null;
  readonly author: string | null;
  readonly pageCount: number | null;
  readonly language: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateDocumentData {
  readonly documentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly status: string;
  readonly sourceType: string;
  readonly sourceFileName: string;
  readonly sourceFileSize: number;
  readonly title?: string | null;
  readonly author?: string | null;
  readonly pageCount?: number | null;
  readonly language?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateDocumentStatusData {
  readonly status: string;
  readonly title?: string | null;
  readonly author?: string | null;
  readonly pageCount?: number | null;
  readonly language?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export interface StoredDocumentChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly locatorKind: string;
  readonly locatorValue: string;
  readonly locatorPage: number | null;
  readonly checksumSha256: string;
}

export interface CreateDocumentChunkData {
  readonly chunkId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly locatorKind: string;
  readonly locatorValue: string;
  readonly locatorPage?: number | null;
  readonly checksumSha256: string;
}

export interface DocumentRepository {
  /**
   * Creates a new document record.
   */
  createDocument(data: CreateDocumentData): Promise<StoredDocument>;

  /**
   * Retrieves a document record by ID (any project; callers verify scope).
   */
  getDocumentById(documentId: string): Promise<StoredDocument | null>;

  /**
   * Lists document records for a single project, optionally filtered by
   * status. Never leaks other projects' documents.
   */
  listDocumentsByProject(projectId: string, statuses?: string[]): Promise<StoredDocument[]>;

  /**
   * Updates a document's status and optional metadata/error fields.
   */
  updateDocumentStatus(documentId: string, data: UpdateDocumentStatusData): Promise<StoredDocument>;

  /**
   * Deletes a document record and its chunks. Idempotent: deleting a missing
   * document succeeds. Throws when the document belongs to another project.
   */
  deleteDocument(documentId: string, projectId: string): Promise<void>;

  /**
   * Persists a batch of chunks for a document.
   */
  createChunks(chunks: CreateDocumentChunkData[]): Promise<StoredDocumentChunk[]>;

  /**
   * Lists a document's chunks scoped to a project, ordered by ordinal.
   */
  listChunksByDocument(documentId: string, projectId: string): Promise<StoredDocumentChunk[]>;

  /**
   * Deletes a document's chunks scoped to a project.
   * Returns the number of deleted chunks.
   */
  deleteChunksByDocument(documentId: string, projectId: string): Promise<number>;
}
