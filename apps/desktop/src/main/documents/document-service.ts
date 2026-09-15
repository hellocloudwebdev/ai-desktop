// PR37: apps/desktop — DocumentService
//
// Project-scoped document ingestion (bytes in, never arbitrary fs reads),
// in-memory lexical search over ready chunks, bounded open, metadata list,
// and lifecycle-enforced removal. Every status change passes through
// VALID_DOCUMENT_TRANSITIONS; cancellation is idempotent via AbortSignal
// semantics (re-checking `signal.aborted` is side-effect free).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createDocumentChunkId,
  createDocumentId,
  DOCUMENT_MAX_CONCURRENT_INGESTIONS,
  DOCUMENT_MAX_EXTRACTED_CHARS,
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_MAX_SEARCH_RESULTS,
  frameDocumentContent,
  isSupportedDocumentMimeType,
  toDocumentEvidence,
  validateDocumentTransition,
  type DocumentChunkId,
  type DocumentEvidenceView,
  type DocumentId,
  type DocumentIngestionResult,
  type DocumentLocator,
  type DocumentLocatorKind,
  type DocumentRetrievalResult,
  type DocumentStatus,
} from "@ai-desktop/ai-core";
import type { DocumentRepository, StoredDocument, StoredDocumentChunk } from "@ai-desktop/storage";
import { DocumentChunker } from "./document-chunker.js";
import {
  DocumentCancelled,
  DocumentMalformed,
  DocumentNotFound,
  DocumentProcessingFailed,
  DocumentProjectMismatch,
  DocumentTooLarge,
  DocumentUnsupportedFormat,
  toCanonicalDocumentError,
} from "./document-errors.js";
import {
  createDefaultDocumentParserRegistry,
  type DocumentParserRegistry,
} from "./document-parsers.js";
import { normalizeParsedDocument } from "./document-normalizer.js";
import { LexicalDocumentRetriever } from "./document-retriever.js";
import { resolveWorkspacePath } from "../agent/filesystem/path-policy.js";

export interface DocumentServiceDeps {
  readonly repository: DocumentRepository;
  readonly parserRegistry?: DocumentParserRegistry;
  readonly chunker?: DocumentChunker;
  readonly retriever?: LexicalDocumentRetriever;
  readonly clock?: () => number;
}

export interface IngestDocumentInput {
  readonly projectId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface IngestDocumentFileInput {
  readonly projectId: string;
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
}

export interface SearchDocumentsInput {
  readonly projectId: string;
  readonly query: string;
  readonly limit?: number;
}

export interface OpenDocumentInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly maxChars?: number;
}

export interface ListDocumentsInput {
  readonly projectId: string;
}

export interface RemoveDocumentInput {
  readonly projectId: string;
  readonly documentId: string;
}

export interface OpenDocumentResult {
  readonly document: StoredDocument;
  readonly text: string;
  readonly chunks: number;
  readonly framed: string;
}

export interface RemoveDocumentResult {
  readonly documentId: string;
  readonly projectId: string;
  readonly status: "deleted";
}

export interface DocumentEvidenceInput {
  readonly chunkId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly text: string;
  readonly locator: { readonly kind: string; readonly value: string };
  readonly documentName: string;
}

/** Cap on ready documents scanned per search (bounded fan-out). */
const MAX_SEARCH_DOCUMENTS = 50;
/** Cap on chunks loaded per search (bounded memory). */
const MAX_SEARCH_CHUNKS = 2000;
/** Default/max chars returned by open. */
const DEFAULT_OPEN_MAX_CHARS = 20000;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
}

/**
 * Tiny inline ingestion limiter (semaphore with FIFO queue). This is a
 * mutual-exclusion counter for concurrent ingestions — NOT the research
 * fan-out limiter (limitParallelism), which serves a different purpose.
 */
class IngestionLimiter {
  private _active = 0;
  private readonly _queue: Array<() => void> = [];

  constructor(private readonly _max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this._active >= this._max) {
      await new Promise<void>((resolve) => {
        this._queue.push(resolve);
      });
    }
    this._active += 1;
    try {
      return await fn();
    } finally {
      this._active -= 1;
      const next = this._queue.shift();
      next?.();
    }
  }
}

function asLocatorKind(kind: string): DocumentLocatorKind {
  if (kind === "page" || kind === "section" || kind === "chunk" || kind === "offset") {
    return kind;
  }
  return "chunk";
}

export class DocumentService {
  private readonly _repository: DocumentRepository;
  private readonly _parsers: DocumentParserRegistry;
  private readonly _chunker: DocumentChunker;
  private readonly _retriever: LexicalDocumentRetriever;
  private readonly _clock: () => number;
  private readonly _limiter = new IngestionLimiter(DOCUMENT_MAX_CONCURRENT_INGESTIONS);

  constructor(deps: DocumentServiceDeps) {
    this._repository = deps.repository;
    this._parsers = deps.parserRegistry ?? createDefaultDocumentParserRegistry();
    this._chunker = deps.chunker ?? new DocumentChunker();
    this._retriever = deps.retriever ?? new LexicalDocumentRetriever();
    this._clock = deps.clock ?? Date.now;
  }

  private _now(): number {
    return this._clock();
  }

  private _requireProject(projectId: string): string {
    if (!projectId || projectId.trim().length === 0) {
      throw new DocumentProcessingFailed("projectId must be a non-empty string");
    }
    return projectId;
  }

  private _throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DocumentCancelled();
    }
  }

  private async _markFailed(
    documentId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const current = await this._repository.getDocumentById(documentId);
    const from = (current?.status ?? "processing") as DocumentStatus;
    if (validateDocumentTransition(from, "failed")) {
      await this._repository.updateDocumentStatus(documentId, {
        status: "failed",
        errorCode,
        errorMessage,
      });
    }
  }

  private async _fail(documentId: string, errorCode: string, error: Error): Promise<never> {
    await this._markFailed(documentId, errorCode, error.message);
    throw error;
  }

  async ingest(input: IngestDocumentInput): Promise<DocumentIngestionResult> {
    const projectId = this._requireProject(input.projectId);
    if (!input.fileName || input.fileName.trim().length === 0) {
      throw new DocumentProcessingFailed("fileName must be a non-empty string");
    }
    const mimeType = normalizeMimeType(input.mimeType);
    if (!isSupportedDocumentMimeType(mimeType)) {
      throw new DocumentUnsupportedFormat(input.mimeType);
    }
    if (input.bytes.length > DOCUMENT_MAX_FILE_BYTES) {
      throw new DocumentTooLarge(
        `Document exceeds the ${DOCUMENT_MAX_FILE_BYTES}-byte limit (${input.bytes.length} bytes)`,
      );
    }
    this._throwIfCancelled(input.signal);

    const checksum = sha256Hex(input.bytes);

    // Within-project dedupe: same bytes already ready → return existing counts.
    const existingDocs = await this._repository.listDocumentsByProject(projectId);
    const duplicate = existingDocs.find(
      (doc) => doc.checksumSha256 === checksum && doc.status === "ready",
    );
    if (duplicate) {
      const existingChunks = await this._repository.listChunksByDocument(
        duplicate.documentId,
        projectId,
      );
      return {
        documentId: duplicate.documentId as DocumentId,
        projectId,
        status: "ready",
        chunksCreated: existingChunks.length,
        checksumSha256: checksum,
      };
    }

    return this._limiter.run(() =>
      this._ingestPipeline({
        projectId,
        fileName: input.fileName,
        mimeType,
        bytes: input.bytes,
        checksum,
        signal: input.signal,
      }),
    );
  }

  private async _ingestPipeline(args: {
    projectId: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    checksum: string;
    signal?: AbortSignal;
  }): Promise<DocumentIngestionResult> {
    const { projectId, fileName, mimeType, bytes, checksum, signal } = args;
    this._throwIfCancelled(signal);

    const documentId = createDocumentId();
    const now = this._now();
    await this._repository.createDocument({
      documentId,
      projectId,
      name: fileName,
      mimeType,
      sizeBytes: bytes.length,
      checksumSha256: checksum,
      status: "processing",
      sourceType: "file",
      sourceFileName: fileName,
      sourceFileSize: bytes.length,
      createdAt: now,
      updatedAt: now,
    });

    // Parse (malformed bytes → failed + DocumentMalformed).
    this._throwIfCancelled(signal);
    const parseOutcome = await this._parseOrFail(documentId, mimeType, fileName, bytes, signal);
    const parsed = parseOutcome.parsed;
    const parsedPages = parseOutcome.pages;

    // Empty text → failed with malformed-content.
    this._throwIfCancelled(signal);
    const normalized = normalizeParsedDocument({
      text: parsed.text,
      pages: parsedPages,
    });
    if (!normalized.text) {
      await this._fail(
        documentId,
        "malformed-content",
        new DocumentMalformed("Document content is empty"),
      );
    }
    if (normalized.text.length > DOCUMENT_MAX_EXTRACTED_CHARS) {
      await this._fail(
        documentId,
        "too-large",
        new DocumentTooLarge(
          `Extracted text exceeds the ${DOCUMENT_MAX_EXTRACTED_CHARS}-char limit`,
        ),
      );
    }

    // Chunk (maxChunks overflow → failed; abort → failed/cancelled).
    this._throwIfCancelled(signal);
    const chunks = await this._chunkOrFail(
      documentId,
      projectId,
      normalized.text,
      normalized.pages,
      checksum,
      signal,
    );
    if (chunks.length === 0) {
      await this._fail(
        documentId,
        "malformed-content",
        new DocumentMalformed("Document content is empty"),
      );
    }

    // Persist chunks.
    this._throwIfCancelled(signal);
    try {
      await this._repository.createChunks(
        chunks.map((chunk) => ({
          chunkId: createDocumentChunkId(),
          documentId,
          projectId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          locatorKind: chunk.locator.kind,
          locatorValue: chunk.locator.value,
          locatorPage: chunk.locator.pageNumber ?? null,
          checksumSha256: chunk.checksum,
        })),
      );
    } catch (err: unknown) {
      if (signal?.aborted) {
        await this._fail(documentId, "cancelled", new DocumentCancelled());
      }
      const canonical = toCanonicalDocumentError(err);
      await this._fail(
        documentId,
        "processing-failed",
        new DocumentProcessingFailed(canonical.message),
      );
    }

    // processing → ready with parser metadata.
    this._throwIfCancelled(signal);
    if (!validateDocumentTransition("processing", "ready")) {
      await this._fail(
        documentId,
        "processing-failed",
        new DocumentProcessingFailed("Illegal document transition: processing → ready"),
      );
    }
    await this._repository.updateDocumentStatus(documentId, {
      status: "ready",
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.author !== undefined ? { author: parsed.author } : {}),
      ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
    });

    return {
      documentId: documentId as DocumentId,
      projectId,
      status: "ready",
      chunksCreated: chunks.length,
      checksumSha256: checksum,
    };
  }

  private async _parseOrFail(
    documentId: string,
    mimeType: string,
    fileName: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    parsed: { text: string; title?: string; author?: string; pageCount?: number };
    pages: Array<{ pageNumber: number; text: string }> | undefined;
  }> {
    try {
      const result = await this._parsers.parse(mimeType, fileName, bytes, signal);
      return {
        parsed: result,
        pages: result.pages ? [...result.pages] : undefined,
      };
    } catch (err: unknown) {
      if (err instanceof DocumentCancelled || signal?.aborted) {
        await this._fail(documentId, "cancelled", new DocumentCancelled());
        throw new DocumentCancelled();
      }
      const canonical = toCanonicalDocumentError(err);
      if (canonical.code === "MALFORMED_CONTENT" || err instanceof DocumentMalformed) {
        const malformed =
          err instanceof DocumentMalformed ? err : new DocumentMalformed(canonical.message);
        await this._fail(documentId, "malformed-content", malformed);
        throw malformed;
      }
      const failed = new DocumentProcessingFailed(canonical.message);
      await this._fail(documentId, "processing-failed", failed);
      throw failed;
    }
  }

  private async _chunkOrFail(
    documentId: string,
    projectId: string,
    text: string,
    pages: ReadonlyArray<{ pageNumber: number; text: string }> | undefined,
    checksum: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      ordinal: number;
      text: string;
      locator: { kind: string; value: string; pageNumber?: number };
      checksum: string;
    }>
  > {
    try {
      return this._chunker.chunk(
        {
          documentId,
          projectId,
          text,
          ...(pages ? { pages } : {}),
          checksum,
        },
        signal,
      );
    } catch (err: unknown) {
      if (err instanceof DocumentCancelled || signal?.aborted) {
        await this._fail(documentId, "cancelled", new DocumentCancelled());
        throw new DocumentCancelled();
      }
      const canonical = toCanonicalDocumentError(err);
      const failed = new DocumentProcessingFailed(canonical.message);
      await this._fail(documentId, "processing-failed", failed);
      throw failed;
    }
  }

  async ingestFile(input: IngestDocumentFileInput): Promise<DocumentIngestionResult> {
    const projectId = this._requireProject(input.projectId);
    // Symlink escapes and outside-workspace paths throw PathPolicyError here.
    const resolved = resolveWorkspacePath(input.workspaceRoot, input.filePath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.targetReal);
    } catch (err: unknown) {
      throw toCanonicalDocumentError(err);
    }
    if (!stat.isFile()) {
      throw new DocumentProcessingFailed(`Path is not a file: "${input.filePath}"`);
    }
    if (stat.size > DOCUMENT_MAX_FILE_BYTES) {
      throw new DocumentTooLarge(
        `Document exceeds the ${DOCUMENT_MAX_FILE_BYTES}-byte limit (${stat.size} bytes)`,
      );
    }
    this._throwIfCancelled(input.signal);

    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(resolved.targetReal);
    } catch (err: unknown) {
      throw toCanonicalDocumentError(err);
    }

    const fileName = path.basename(resolved.targetReal);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = EXTENSION_MIME_TYPES[ext];
    if (!mimeType) {
      throw new DocumentUnsupportedFormat(
        ext || fileName,
        `No parser supports file extension "${ext || fileName}"`,
      );
    }

    return this.ingest({
      projectId,
      fileName,
      mimeType,
      bytes,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async search(input: SearchDocumentsInput): Promise<DocumentRetrievalResult> {
    const projectId = this._requireProject(input.projectId);
    if (!input.query || input.query.trim().length === 0) {
      throw new DocumentProcessingFailed("query must be a non-empty string");
    }
    const limit = Math.max(1, Math.min(DOCUMENT_MAX_SEARCH_RESULTS, Math.floor(input.limit ?? 10)));

    // Ready documents for this project ONLY, bounded scan.
    const docs = await this._repository.listDocumentsByProject(projectId, ["ready"]);
    const scanned = docs.slice(0, MAX_SEARCH_DOCUMENTS);

    const records: Array<{
      chunkId: string;
      documentId: string;
      projectId: string;
      text: string;
      locator: { kind: string; value: string; pageNumber?: number };
      documentName: string;
    }> = [];
    const docNames = new Map<string, string>();
    for (const doc of scanned) {
      docNames.set(doc.documentId, doc.name);
    }
    for (const doc of scanned) {
      if (records.length >= MAX_SEARCH_CHUNKS) {
        break;
      }
      const chunks = await this._repository.listChunksByDocument(doc.documentId, projectId);
      for (const chunk of chunks) {
        if (records.length >= MAX_SEARCH_CHUNKS) {
          break;
        }
        records.push({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          projectId: chunk.projectId,
          text: chunk.text,
          locator: {
            kind: chunk.locatorKind,
            value: chunk.locatorValue,
            ...(chunk.locatorPage != null ? { pageNumber: chunk.locatorPage } : {}),
          },
          documentName: docNames.get(chunk.documentId) ?? doc.name,
        });
      }
    }

    const matches = this._retriever.search(records, input.query, limit).map((match) => {
      const record = records.find((candidate) => candidate.chunkId === match.chunkId);
      const locator = record?.locator ?? { kind: "chunk", value: "chunk-0" };
      return {
        chunkId: match.chunkId as DocumentChunkId,
        documentId: match.documentId as DocumentId,
        projectId,
        score: match.score,
        matchedTerms: [...match.matchedTerms],
        matchType: match.matchType,
        text: record?.text ?? "",
        locator: {
          kind: asLocatorKind(locator.kind),
          value: locator.value,
          ...(locator.pageNumber !== undefined ? { pageNumber: locator.pageNumber } : {}),
        },
        documentName: record?.documentName ?? "",
      };
    });

    return {
      query: input.query,
      matches,
      searchedAt: new Date(this._now()).toISOString(),
      totalChunks: records.length,
    };
  }

  async open(input: OpenDocumentInput): Promise<OpenDocumentResult> {
    const projectId = this._requireProject(input.projectId);
    const doc = await this._repository.getDocumentById(input.documentId);
    if (!doc) {
      throw new DocumentNotFound(`Document "${input.documentId}" not found`);
    }
    if (doc.projectId !== projectId) {
      throw new DocumentProjectMismatch("Document does not belong to the requested project");
    }
    if (doc.status === "deleted") {
      throw new DocumentNotFound(`Document "${input.documentId}" has been deleted`);
    }
    if (doc.status !== "ready") {
      throw new DocumentProcessingFailed(
        `Document "${input.documentId}" is not ready (status: ${doc.status})`,
      );
    }

    const maxChars =
      input.maxChars === undefined
        ? DEFAULT_OPEN_MAX_CHARS
        : Math.max(1, Math.min(DEFAULT_OPEN_MAX_CHARS, Math.floor(input.maxChars)));
    const chunks = await this._repository.listChunksByDocument(doc.documentId, projectId);
    const full = chunks.map((chunk) => chunk.text).join("\n");
    const text = full.slice(0, maxChars);
    return {
      document: doc,
      text,
      chunks: chunks.length,
      framed: frameDocumentContent(text, { documentName: doc.name, projectId }),
    };
  }

  async list(input: ListDocumentsInput): Promise<StoredDocument[]> {
    const projectId = this._requireProject(input.projectId);
    // Metadata only — StoredDocument carries no chunk text or raw bytes.
    return this._repository.listDocumentsByProject(projectId);
  }

  async remove(input: RemoveDocumentInput): Promise<RemoveDocumentResult> {
    const projectId = this._requireProject(input.projectId);
    const doc = await this._repository.getDocumentById(input.documentId);
    if (!doc) {
      return { documentId: input.documentId, projectId, status: "deleted" };
    }
    if (doc.projectId !== projectId) {
      throw new DocumentProjectMismatch("Document does not belong to the requested project");
    }
    if (doc.status === "deleted") {
      return { documentId: input.documentId, projectId, status: "deleted" };
    }
    const from = doc.status as DocumentStatus;
    if (!validateDocumentTransition(from, "deleted")) {
      throw new DocumentProcessingFailed(`Illegal document transition: ${doc.status} → deleted`);
    }
    await this._repository.updateDocumentStatus(input.documentId, { status: "deleted" });
    await this._repository.deleteChunksByDocument(input.documentId, projectId);
    await this._repository.deleteDocument(input.documentId, projectId);
    return { documentId: input.documentId, projectId, status: "deleted" };
  }

  toEvidence(match: DocumentEvidenceInput): DocumentEvidenceView {
    const locator: DocumentLocator = {
      kind: asLocatorKind(match.locator.kind),
      value: match.locator.value,
    };
    return toDocumentEvidence({
      chunkId: match.chunkId as DocumentChunkId,
      documentId: match.documentId as DocumentId,
      projectId: match.projectId,
      text: match.text,
      locator,
      documentName: match.documentName,
    });
  }

  /** Exposes the raw chunk rows for a project-scoped document (testing support). */
  async listChunks(documentId: string, projectId: string): Promise<StoredDocumentChunk[]> {
    return this._repository.listChunksByDocument(documentId, projectId);
  }
}
