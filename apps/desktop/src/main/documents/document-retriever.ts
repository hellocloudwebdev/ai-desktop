// PR37: apps/desktop — Lexical Document Retriever
//
// Scores stored chunks against a query with pure lexical signals: phrase
// matches outrank term overlap, and a hit in the document name adds a small
// bonus. There is deliberately NO truth or quality language here — fields are
// scores, matched terms, and match types only. Ordering is fully stable:
// score desc, then documentId asc, then chunkId asc.

export type DocumentMatchType = "phrase" | "term";

export interface DocumentChunkRecord {
  readonly chunkId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly text: string;
  readonly locator: { readonly kind: string; readonly value: string; readonly pageNumber?: number };
  readonly documentName: string;
}

export interface DocumentMatch {
  readonly chunkId: string;
  readonly documentId: string;
  readonly score: number;
  readonly matchedTerms: string[];
  readonly matchType: DocumentMatchType;
}

export interface DocumentChunkStore {
  readonly chunks: ReadonlyArray<DocumentChunkRecord>;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function normalizedForm(value: string): string {
  return tokenize(value).join(" ");
}

export class LexicalDocumentRetriever {
  search(chunks: ReadonlyArray<DocumentChunkRecord>, query: string, limit = 10): DocumentMatch[] {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) {
      return [];
    }
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) {
      return [];
    }
    const normalizedQuery = terms.join(" ");
    const matches: DocumentMatch[] = [];
    for (const chunk of chunks) {
      const match = scoreChunk(chunk, terms, normalizedQuery);
      if (match) {
        matches.push(match);
      }
    }
    matches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.documentId !== b.documentId) {
        return a.documentId < b.documentId ? -1 : 1;
      }
      return a.chunkId < b.chunkId ? (a.chunkId > b.chunkId ? 1 : -1) : 0;
    });
    return matches.slice(0, boundedLimit);
  }
}

function scoreChunk(
  chunk: DocumentChunkRecord,
  terms: string[],
  normalizedQuery: string,
): DocumentMatch | null {
  const normalizedText = normalizedForm(chunk.text);
  if (!normalizedText) {
    return null;
  }
  const textTokens = new Set(normalizedText.split(" "));
  const matchedTerms = terms.filter((term) => textTokens.has(term));
  const isPhrase = normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery);
  if (!isPhrase && matchedTerms.length === 0) {
    return null;
  }
  let score: number;
  let matchType: DocumentMatchType;
  if (isPhrase) {
    matchType = "phrase";
    score = 2 * terms.length;
  } else {
    matchType = "term";
    score = matchedTerms.length;
    if (normalizedText.includes(normalizedQuery)) {
      score += 1.5;
    }
  }
  const nameTokens = new Set(tokenize(chunk.documentName));
  if (matchedTerms.some((term) => nameTokens.has(term))) {
    score += 1;
  }
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    score,
    matchedTerms,
    matchType,
  };
}

export function searchInProject(
  store: DocumentChunkStore,
  projectId: string,
  query: string,
  limit = 10,
): DocumentMatch[] {
  const retriever = new LexicalDocumentRetriever();
  const scoped = store.chunks.filter((chunk) => chunk.projectId === projectId);
  return retriever.search(scoped, query, limit);
}
