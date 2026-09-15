// PR37: apps/desktop — Deterministic Document Chunker
//
// Splits normalized document text into bounded, overlapping chunks. Sentences
// are greedily packed up to maxChunkChars; each chunk after the first
// re-opens with trailing sentences of its predecessor (bounded by
// overlapChars) so context survives boundaries. Page locators come from the
// parsed page structure; chunk checksums are SHA-256 over
// `${documentId}:${ordinal}:${text}`. Deterministic: identical input always
// yields identical chunks.

import { createHash } from "node:crypto";
import { DocumentCancelled, DocumentProcessingFailed } from "./document-errors.js";

export interface DocumentChunkerOptions {
  readonly maxChunkChars?: number;
  readonly overlapChars?: number;
  readonly maxChunks?: number;
}

export interface DocumentChunkInputPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface DocumentChunkInput {
  readonly documentId: string;
  readonly projectId: string;
  readonly text: string;
  readonly pages?: ReadonlyArray<DocumentChunkInputPage>;
  readonly checksum?: string;
}

export interface DocumentChunkLocator {
  readonly kind: "page" | "chunk";
  readonly value: string;
  readonly pageNumber?: number;
}

export interface DocumentChunk {
  readonly ordinal: number;
  readonly text: string;
  readonly locator: DocumentChunkLocator;
  readonly checksum: string;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class DocumentChunker {
  private readonly _maxChunkChars: number;
  private readonly _overlapChars: number;
  private readonly _maxChunks: number;

  constructor(opts?: DocumentChunkerOptions) {
    this._maxChunkChars = Math.max(1, Math.floor(opts?.maxChunkChars ?? 4000));
    this._overlapChars = Math.max(0, Math.floor(opts?.overlapChars ?? 400));
    this._maxChunks = Math.max(1, Math.floor(opts?.maxChunks ?? 2000));
  }

  chunk(input: DocumentChunkInput, signal?: AbortSignal): DocumentChunk[] {
    if (signal?.aborted) {
      throw new DocumentCancelled();
    }
    const text = input.text ?? "";
    if (!text.trim()) {
      return [];
    }
    const sentences = text
      .split(SENTENCE_SPLIT)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length === 0) {
      return [];
    }
    const units = splitLongSentences(sentences, this._maxChunkChars);

    const chunks: DocumentChunk[] = [];
    let start = 0;
    let ordinal = 0;
    while (start < units.length) {
      if (signal?.aborted) {
        throw new DocumentCancelled();
      }
      if (ordinal >= this._maxChunks) {
        throw new DocumentProcessingFailed(
          `Document chunking exceeded maxChunks (${this._maxChunks})`,
        );
      }
      let end = start;
      let length = 0;
      while (end < units.length) {
        const unit = units[end] as string;
        const add = end === start ? unit.length : 1 + unit.length;
        if (length + add > this._maxChunkChars && end > start) {
          break;
        }
        length += add;
        end += 1;
      }
      const slice = units.slice(start, end);
      const chunkText = slice.join(" ");
      if (!chunkText) {
        start = end;
        continue;
      }
      const locator = locateChunk(slice[0] as string, chunkText, input.pages, ordinal);
      chunks.push({
        ordinal,
        text: chunkText,
        locator,
        checksum: sha256Hex(`${input.documentId}:${ordinal}:${chunkText}`),
      });
      ordinal += 1;
      if (end >= units.length) {
        break;
      }
      start = nextStart(units, start, end, this._overlapChars);
    }
    return chunks;
  }
}

function splitLongSentences(sentences: string[], maxChunkChars: number): string[] {
  const units: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChunkChars) {
      units.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += maxChunkChars) {
      units.push(sentence.slice(i, i + maxChunkChars));
    }
  }
  return units;
}

function nextStart(units: string[], start: number, end: number, overlapChars: number): number {
  if (overlapChars <= 0) {
    return end;
  }
  let overlapStart = end;
  let overlapLength = 0;
  for (let k = end - 1; k > start; k -= 1) {
    const candidate = units[k] as string;
    const add = overlapLength === 0 ? candidate.length : 1 + candidate.length;
    if (overlapLength + add > overlapChars) {
      break;
    }
    overlapLength += add;
    overlapStart = k;
  }
  if (overlapStart <= start || overlapStart >= end) {
    return end;
  }
  return overlapStart;
}

function locateChunk(
  firstSentence: string,
  chunkText: string,
  pages: ReadonlyArray<DocumentChunkInputPage> | undefined,
  ordinal: number,
): DocumentChunkLocator {
  if (pages && pages.length > 0) {
    const probe = (firstSentence ?? "").trim();
    if (probe) {
      for (const page of pages) {
        if (page.text.includes(probe)) {
          return { kind: "page", value: `page-${page.pageNumber}`, pageNumber: page.pageNumber };
        }
      }
    }
    const prefix = chunkText.slice(0, 80).trim();
    if (prefix) {
      for (const page of pages) {
        if (page.text.includes(prefix)) {
          return { kind: "page", value: `page-${page.pageNumber}`, pageNumber: page.pageNumber };
        }
      }
    }
  }
  return { kind: "chunk", value: `chunk-${ordinal}` };
}
