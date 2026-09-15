// PR37: apps/desktop — Document Retriever Tests

import { describe, expect, it } from "vitest";
import {
  LexicalDocumentRetriever,
  searchInProject,
  type DocumentChunkRecord,
} from "../document-retriever.js";

const chunk = (
  chunkId: string,
  documentId: string,
  projectId: string,
  text: string,
  documentName = "notes.txt",
): DocumentChunkRecord => ({
  chunkId,
  documentId,
  projectId,
  text,
  locator: { kind: "chunk", value: chunkId },
  documentName,
});

const CORPUS: DocumentChunkRecord[] = [
  chunk("c1", "doc-a", "p1", "The quick brown fox jumps over the lazy dog.", "animals.txt"),
  chunk("c2", "doc-b", "p1", "Local inference runs fastest on consumer GPUs.", "inference.txt"),
  chunk(
    "c3",
    "doc-b",
    "p1",
    "Quantization reduces memory with modest quality loss.",
    "inference.txt",
  ),
  chunk("c4", "doc-c", "p2", "Quantization reduces memory with modest quality loss.", "other.txt"),
];

describe("LexicalDocumentRetriever", () => {
  const retriever = new LexicalDocumentRetriever();

  it("matches exact phrases with matchType phrase", () => {
    const matches = retriever.search(CORPUS, "quick brown fox");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.chunkId).toBe("c1");
    expect(matches[0]?.matchType).toBe("phrase");
  });

  it("matches single terms with matchType term", () => {
    const matches = retriever.search(CORPUS, "quantization memory");
    const byId = new Map(matches.map((m) => [m.chunkId, m]));
    expect(byId.get("c3")?.matchType).toBe("term");
    expect(byId.get("c3")?.matchedTerms).toContain("quantization");
    expect(byId.get("c3")?.matchedTerms).toContain("memory");
  });

  it("ranks phrase matches above partial term matches", () => {
    const docs = [
      chunk("t1", "doc-x", "p1", "Quantization helps. Memory is unrelated here.", "x.txt"),
      chunk("t2", "doc-y", "p1", "Quantization reduces memory.", "y.txt"),
    ];
    const matches = retriever.search(docs, "quantization reduces memory");
    expect(matches[0]?.chunkId).toBe("t2");
    expect(matches[0]?.matchType).toBe("phrase");
  });

  it("adds a title bonus for terms in the document name", () => {
    const docs = [
      chunk("n1", "doc-m", "p1", "The fox runs at night.", "other.txt"),
      chunk("n2", "doc-n", "p1", "The fox runs at night.", "fox-field-guide.txt"),
    ];
    const matches = retriever.search(docs, "fox");
    expect(matches[0]?.chunkId).toBe("n2");
  });

  it("bounds results to top K", () => {
    const docs = Array.from({ length: 8 }, (_, i) =>
      chunk(`k${i}`, `doc-${i}`, "p1", `Shared token appears in chunk ${i}.`, "s.txt"),
    );
    const matches = retriever.search(docs, "shared token", 3);
    expect(matches).toHaveLength(3);
  });

  it("returns [] when nothing matches", () => {
    expect(retriever.search(CORPUS, "xylophone zebra")).toEqual([]);
  });

  it("returns [] for blank or too-short-token queries", () => {
    expect(retriever.search(CORPUS, "")).toEqual([]);
    expect(retriever.search(CORPUS, "a be")).toEqual([]);
  });

  it("returns [] for empty chunk lists and zero limits", () => {
    expect(retriever.search([], "fox")).toEqual([]);
    expect(retriever.search(CORPUS, "fox", 0)).toEqual([]);
  });

  it("breaks score ties deterministically by documentId then chunkId", () => {
    const docs = [
      chunk("z2", "doc-b", "p1", "Fox trots.", "t.txt"),
      chunk("a1", "doc-a", "p1", "Fox trots.", "t.txt"),
      chunk("a2", "doc-a", "p1", "Fox trots.", "t.txt"),
    ];
    const first = retriever.search(docs, "fox");
    const second = retriever.search(docs, "fox");
    expect(first.map((m) => m.chunkId)).toEqual(["a1", "a2", "z2"]);
    expect(second.map((m) => m.chunkId)).toEqual(first.map((m) => m.chunkId));
  });

  it("is case-insensitive", () => {
    const matches = retriever.search(CORPUS, "QUANTIZATION");
    expect(matches.some((m) => m.chunkId === "c3")).toBe(true);
  });

  it("exposes score and matchedTerms on every match", () => {
    const matches = retriever.search(CORPUS, "consumer gpus");
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(typeof match.score).toBe("number");
      expect(Array.isArray(match.matchedTerms)).toBe(true);
      expect(match.matchedTerms.length).toBeGreaterThan(0);
    }
  });
});

describe("searchInProject", () => {
  const store = { chunks: CORPUS };

  it("filters matches by projectId", () => {
    const matches = searchInProject(store, "p2", "quantization memory");
    expect(matches.map((m) => m.chunkId)).toEqual(["c4"]);
  });

  it("returns [] for unknown projects", () => {
    expect(searchInProject(store, "nope", "quantization")).toEqual([]);
  });

  it("respects the limit within a project", () => {
    const matches = searchInProject(store, "p1", "the", 1);
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});
