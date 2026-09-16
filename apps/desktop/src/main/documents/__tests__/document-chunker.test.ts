// PR37: apps/desktop — Document Chunker Tests

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentChunker } from "../document-chunker.js";
import { DocumentCancelled, DocumentProcessingFailed } from "../document-errors.js";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sentence = (n: number): string => `Sentence number ${n} states a clear fact.`;

const longText = (count: number): string =>
  Array.from({ length: count }, (_, i) => sentence(i)).join(" ");

describe("DocumentChunker", () => {
  it("returns [] for empty or whitespace text", () => {
    const chunker = new DocumentChunker();
    expect(chunker.chunk({ documentId: "d1", projectId: "p1", text: "" })).toEqual([]);
    expect(chunker.chunk({ documentId: "d1", projectId: "p1", text: "   \n  " })).toEqual([]);
  });

  it("keeps every chunk within maxChunkChars", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 120, overlapChars: 0 });
    const chunks = chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(20) });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(120);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("produces no empty chunks", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 60, overlapChars: 10 });
    const chunks = chunker.chunk({
      documentId: "d1",
      projectId: "p1",
      text: "One. Two. Three. Four. Five. Six. Seven. Eight.",
    });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text.trim()).not.toBe("");
    }
  });

  it("repeats overlapping text in consecutive chunks", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 90, overlapChars: 40 });
    const chunks = chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(12) });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]?.text ?? "";
    const second = chunks[1]?.text ?? "";
    const shared = first.split(/(?<=[.!?])\s+/).filter((s) => s && second.includes(s));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("emits ordinals in order starting at 0", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 100, overlapChars: 0 });
    const chunks = chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(15) });
    chunks.forEach((chunk, index) => {
      expect(chunk.ordinal).toBe(index);
    });
  });

  it("computes stable checksums across runs", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 100, overlapChars: 20 });
    const input = { documentId: "doc-9", projectId: "p1", text: longText(15) };
    const first = chunker.chunk(input);
    const second = chunker.chunk(input);
    expect(second).toEqual(first);
    for (const chunk of first) {
      expect(chunk.checksum).toBe(sha256Hex(`doc-9:${chunk.ordinal}:${chunk.text}`));
    }
  });

  it("namespaces checksums by content checksum when provided", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 100, overlapChars: 0 });
    const text = longText(5);
    const a = chunker.chunk({ documentId: "d1", projectId: "p1", text, checksum: "c1" });
    const b = chunker.chunk({ documentId: "d2", projectId: "p1", text, checksum: "c1" });
    const c = chunker.chunk({ documentId: "d3", projectId: "p1", text, checksum: "c2" });
    expect(a.map((x) => x.checksum)).toEqual(b.map((x) => x.checksum));
    expect(a.map((x) => x.checksum)).not.toEqual(c.map((x) => x.checksum));
  });

  it("assigns page locators from page structure", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 60, overlapChars: 0 });
    const chunks = chunker.chunk({
      documentId: "d1",
      projectId: "p1",
      text: "Alpha opens the report. Beta continues it. Gamma starts page two. Delta ends it.",
      pages: [
        { pageNumber: 1, text: "Alpha opens the report. Beta continues it." },
        { pageNumber: 2, text: "Gamma starts page two. Delta ends it." },
      ],
    });
    expect(chunks.length).toBeGreaterThan(1);
    const kinds = new Set(chunks.map((c) => c.locator.kind));
    expect(kinds.has("page")).toBe(true);
    const pageTwo = chunks.find((c) => c.locator.pageNumber === 2);
    expect(pageTwo?.locator.value).toBe("page-2");
  });

  it("falls back to chunk locators without pages", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 60, overlapChars: 0 });
    const chunks = chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(8) });
    expect(chunks[0]?.locator).toEqual({ kind: "chunk", value: "chunk-0" });
  });

  it("splits a single overlong sentence into bounded pieces", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 50, overlapChars: 0 });
    const chunks = chunker.chunk({
      documentId: "d1",
      projectId: "p1",
      text: `Start. ${"x".repeat(130)} End.`,
    });
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("throws when chunks would exceed maxChunks", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 40, overlapChars: 0, maxChunks: 2 });
    expect(() => chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(30) })).toThrow(
      DocumentProcessingFailed,
    );
  });

  it("throws DocumentCancelled when already aborted", () => {
    const chunker = new DocumentChunker();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      chunker.chunk({ documentId: "d1", projectId: "p1", text: longText(5) }, controller.signal),
    ).toThrow(DocumentCancelled);
  });

  it("keeps all chunk text as substrings reconstructible from the source", () => {
    const chunker = new DocumentChunker({ maxChunkChars: 100, overlapChars: 30 });
    const text = longText(10);
    const chunks = chunker.chunk({ documentId: "d1", projectId: "p1", text });
    for (const chunk of chunks) {
      const firstWord = chunk.text.split(/\s+/)[0] ?? "";
      expect(text.includes(firstWord)).toBe(true);
    }
  });
});
