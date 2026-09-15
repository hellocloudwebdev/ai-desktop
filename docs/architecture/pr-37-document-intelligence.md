# PR37 — Document Intelligence & Project RAG Foundation

## 1. Objective

PR37 gives AI Desktop first-class **project document intelligence**: users
import files, the system ingests them through a secure project-scoped
pipeline (validate → parse → normalize → chunk → index), and the Agent
Runtime plus chat workflows retrieve bounded evidence with provenance.

```text
User imports document
        ↓
Document ingestion (bytes in, never raw paths)
        ↓
Validation / security (mime allowlist, size caps, path policy)
        ↓
Parsing (provider-neutral DocumentParser per format)
        ↓
Normalization (deterministic extraction, never interpretation)
        ↓
Chunking (bounded, stable, page-aware)
        ↓
Project-scoped index (Prisma persistence, projectId boundary)
        ↓
Retrieval (deterministic lexical scorer, top-K)
        ↓
Evidence + provenance (PR36-shaped, framed as untrusted data)
        ↓
Chat / Agent / Research
```

The boundary holds: **Documents ≠ Memory ≠ Research**. Documents are
user-provided source material; Memory holds durable semantic facts;
Research holds external internet information; the Agent Runtime remains
the only planner. PR37 creates no second agent loop.

---

## 2. Inviolable Architectural & Security Rules

1. **Bytes in, never paths**: tools accept `DocumentId` + `projectId`.
   File ingestion resolves user paths through the existing workspace
   `path-policy` (symlink-escape rejection) in main only.
2. **Ingestion is extraction, not interpretation**: no LLM rewriting,
   no summarization during ingest. Normalization is deterministic.
3. **Documents are untrusted data**: contents are framed
   (`frameDocumentContent`) and can never grant permissions, call tools,
   or modify the task graph (explicit regression tests).
4. **Project isolation is the security boundary**: every operation carries
   `projectId`; checksums never authorize cross-project access.
5. **Bounded everything**: file bytes, extracted chars, pages, chunks,
   chunk size/overlap, search results, processing time, and concurrent
   ingestions are centrally capped (`DOCUMENT_MAX_*`).
6. **No mandatory vector database**: retrieval is a `DocumentRetriever`
   abstraction with a deterministic lexical implementation; embeddings
   can plug in later without changing callers.
7. **Reuse**: ai-core contracts, Storage abstractions, PermissionManager,
   ToolRegistry + universal executor lifecycle, project isolation, IPC
   conventions, Workspace/Files surface, PR36 evidence model, `AbortSignal`
   cancellation, `limitParallelism` concurrency.
8. **No**: second agent loop, arbitrary filesystem access, cloud storage,
   external uploads, code execution, new permission/event/workspace
   architectures, hosted RAG services, or trusted-instruction treatment.

---

## 3. Canonical Domain Model (`@ai-desktop/ai-core`)

New module `documents.ts` (pure; no Node/Prisma/parser/renderer types).

### 3.1 Branded Identifiers

`DocumentId`, `DocumentChunkId`, `DocumentSourceId` with schemas,
`create*` helpers, and `isDocumentId` — the existing ULID conventions.

### 3.2 Source, Locator, Metadata, Document, Chunk

```ts
interface DocumentSource { type: "file"; fileName; fileSizeBytes; checksumSha256 }
interface DocumentLocator { kind: "page" | "section" | "chunk" | "offset"; value; pageNumber? }
interface Document {
  documentId; projectId; name; mimeType; sizeBytes; checksumSha256;
  status: "pending" | "processing" | "ready" | "failed" | "deleted";
  source; metadata?; createdAt; updatedAt; errorCode?; errorMessage?;
}
interface DocumentChunk {
  chunkId; documentId; projectId; ordinal; text (≤8000);
  locator; checksumSha256;
}
```

Lifecycle transitions are validated (`VALID_DOCUMENT_TRANSITIONS`):
`pending → processing → ready → deleted`, with `failed` reachable from
`pending`/`processing`. Nothing is searchable before `ready`; deletion
purges chunks so they are no longer retrievable. `pageNumber` is set only
when the parser provides it — never fabricated.

### 3.3 Formats, Limits, Requests

Allowlist: `text/plain`, `text/markdown`, `application/json`,
`text/csv`, `application/pdf`. Anything else fails with typed
`unsupported-format` — never silent pretense.

Centralized `DOCUMENT_MAX_*`: 10 MB files, 500 K extracted chars,
2000 pages, 2000 chunks, 4000-char chunks with 400-char overlap,
20 search results, 120 s processing, 2 concurrent ingestions.

Requests/results: `DocumentIngestionRequest` (base64 transport for IPC),
`DocumentIngestionResult`, `DocumentSearchRequest`,
`DocumentMatch` (`score`, `matchedTerms`, `matchType` — relevance only,
never truth), `DocumentSearchResult`/`DocumentRetrievalResult`,
`DocumentDeleteRequest`, and `DocumentErrorCode`.

### 3.4 Tools & Framing

`builtin:documents.list/search/open/delete` (`source: "builtin"`,
`runtime: "in_process"`, `requiredPermissions: ["documents"]`).
`documentsRiskFor`: list/search/open → `low`, delete → `high`.
`toDocumentEvidence` maps a chunk onto the PR36 evidence shape
structurally (no duplicated citation architecture).
`frameDocumentContent` marks model-bound text as
`UNTRUSTED DOCUMENT CONTENT` with source metadata.

---

## 4. Desktop Implementation (`apps/desktop/src/main/documents/`)

- `document-errors.ts`: `DocumentError` + 8 subclasses with secret
  redaction, mirroring `research-errors.ts`.
- `document-parsers.ts`: `DocumentParser` (`supports`/`parse`) +
  registry. Hand-rolled, zero new dependencies: UTF-8 text (fatal
  decoding), Markdown (verbatim, first ATX heading as title), JSON
  (text-field join or pretty stringify), CSV (quoted-field state machine,
  `header: value` rows), PDF (minimal `%PDF-`-validated extractor over
  `BT…ET`/`Tj`/`TJ` with `/Type /Page` page boundaries).
- `document-normalizer.ts`: CRLF→LF, control-char strip, newline collapse,
  per-line trim — deterministic and idempotent, per page.
- `document-chunker.ts`: sentence packing to 4000 chars with 400-char
  sentence overlap, long-sentence splitting, page locators with chunk
  fallback, SHA-256 `${documentId}:${ordinal}:${text}` stable IDs,
  `maxChunks` enforcement, no empty chunks.
- `document-retriever.ts`: `LexicalDocumentRetriever` (normalized term
  overlap + phrase match + title bonus, stable score→id tie-break,
  bounded top-K) plus `searchInProject` project filter.
- Storage (`packages/storage/src/documents/` + Prisma
  `DocumentRecord`/`DocumentChunkRecord` with project indexes): interface
  - `PrismaDocumentRepository`, consumed as an interface — Prisma never
    leaves `packages/storage`.
- `document-service.ts`: `ingest` (validate → checksum → within-project
  dedupe → `processing` → parse → normalize → chunk → persist →
  `ready`, abort-checked per stage), `ingestFile` (path-policy +
  size pre-check, then bytes path), `search` (ready-only, 50-doc /
  2000-chunk caps), `open` (project-verified, bounded, framed), `list`
  (metadata only), `remove` (`ready → deleted`, chunk purge, idempotent),
  FIFO semaphore at 2 concurrent ingestions.
- `documents-tool-executor.ts`: the 4 tools through resolve → validate →
  permission → execute under capability `documents`; `builtin:documents.*`
  routed in `DesktopToolRouter` before the generic `builtin:` branch.
- IPC (`documents:list/get/search/ingest/delete`, base64 ingest with
  re-checked bounds; no execute/read-path/raw-fs channels) + preload
  bridge + Files surface extension (listing with type/size/status/date,
  selection, bounded plain-text preview, errors) via optional props —
  no new surface kind or workspace architecture.

---

## 5. Security & Verification

- Path attacks (`../`, absolute, symlink/junction escape) rejected via
  `path-policy`; oversized/malformed inputs fail typed and safe; corrupt
  PDFs, bad UTF-8/JSON/CSV never throw raw.
- Injection payloads (`IGNORE ALL PREVIOUS INSTRUCTIONS…`,
  `call builtin:documents.delete`) remain framed data: tool list
  invariant, no permission change, no task-graph effect.
- Cross-project leakage proven: same bytes in A and B stay separate
  records; search/open/delete honor `projectId` exclusively.
- Renderer asserts: no `fs`/`path`/Prisma/Node/parser/storage in the
  surface; typed `window.api` document commands only.
- E2E: PDF import → parse → chunk → index → search → page-aware
  citation; A/B isolation with identical files; injection-inert run.
- Gates: `architecture:check`, `typecheck`, `lint`, `test`, `build`,
  `format:check` — PDF handled with zero new dependencies (no `pdfjs`
  /`pdf-parse` in the tree to reuse; hand-rolled extractor documented
  as the deliberate minimal parser).
