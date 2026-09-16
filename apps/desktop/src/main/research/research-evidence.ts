// PR36: apps/desktop — Deterministic Evidence Extractor
//
// Converts research documents into bounded evidence blocks. Every excerpt is
// a verbatim substring of the source text — the extractor NEVER manufactures
// wording. The query-term scoring only ranks sentences; with no terms the
// leading sentences win. Locators identify paragraph blocks supplied by the
// document structure, never invented line numbers.

import { createTimestamp } from "@ai-desktop/shared";

export interface ExtractEvidenceInput {
  readonly sourceId: string;
  readonly text: string;
  readonly queryTerms?: readonly string[];
  readonly requestId?: string;
  readonly retrievedAt?: string;
}

export interface ExtractedEvidence {
  readonly sourceId: string;
  readonly excerpt: string;
  readonly locator?: { kind: "paragraph"; value: string };
  readonly requestId?: string;
  readonly retrievedAt: string;
}

export interface EvidenceExtractorOptions {
  readonly maxExcerpts?: number;
  readonly maxCharsPerExcerpt?: number;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export class EvidenceExtractor {
  private readonly _maxExcerpts: number;
  private readonly _maxCharsPerExcerpt: number;

  constructor(opts?: EvidenceExtractorOptions) {
    this._maxExcerpts = Math.max(1, opts?.maxExcerpts ?? 3);
    this._maxCharsPerExcerpt = Math.max(16, opts?.maxCharsPerExcerpt ?? 500);
  }

  extract(input: ExtractEvidenceInput): ExtractedEvidence[] {
    const text = input.text;
    if (!text || !text.trim()) {
      return [];
    }
    const terms = (input.queryTerms ?? []).map((t) => t.toLowerCase()).filter(Boolean);
    const paragraphs = text.split(/\n\s*\n/);
    const paragraphOf = new Array<number>();
    const sentences: string[] = [];
    paragraphs.forEach((block, blockIndex) => {
      const parts = block
        .split(SENTENCE_SPLIT)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const part of parts) {
        paragraphOf.push(blockIndex);
        sentences.push(part);
      }
    });
    if (sentences.length === 0) {
      return [];
    }
    const scored = sentences.map((sentence, index) => {
      const lower = sentence.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let at = 0;
        while (true) {
          const found = lower.indexOf(term, at);
          if (found < 0) {
            break;
          }
          score += 1;
          at = found + term.length;
        }
      }
      return { sentence, index, score };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const winners = scored.slice(0, this._maxExcerpts);
    winners.sort((a, b) => a.index - b.index);
    const retrievedAt = input.retrievedAt ?? createTimestamp();
    return winners.map(({ sentence, index }) => {
      let excerpt = sentence;
      if (excerpt.length > this._maxCharsPerExcerpt) {
        const cut = excerpt.slice(0, this._maxCharsPerExcerpt);
        const lastSpace = cut.lastIndexOf(" ");
        excerpt = `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
      }
      const probe = excerpt.endsWith("…") ? excerpt.slice(0, -1).trimEnd() : excerpt;
      if (!text.includes(probe)) {
        throw new Error("EvidenceExtractor produced a non-verbatim excerpt");
      }
      const paragraphIndex = paragraphOf[index] ?? 0;
      return {
        sourceId: input.sourceId,
        excerpt,
        locator: { kind: "paragraph" as const, value: `paragraph-${paragraphIndex}` },
        ...(input.requestId ? { requestId: input.requestId } : {}),
        retrievedAt,
      };
    });
  }
}
