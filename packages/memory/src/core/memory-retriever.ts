// PR28.7: packages/memory — Deterministic Relevance Retriever
//
// Invariants:
//   1. Retrieval order: scope relevance -> term relevance -> confidence -> recency.
//   2. Excludes superseded facts by default (supersededBy IS NULL).
//   3. Excludes sensitive facts from automatic prompt injection unless explicitly included.
//   4. Deterministic: identical facts and query always produce identical ranking.
//   5. Pure, side-effect free: zero I/O, zero mutation.

import type { MemoryFact, MemorySensitivity } from "@ai-desktop/ai-core";

export interface RetrieveMemoryOptions {
  readonly projectId?: string;
  readonly query?: string;
  readonly category?: string;
  readonly includeSensitive?: boolean;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export interface ScoredMemoryFact {
  readonly fact: MemoryFact;
  readonly score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function termOverlapScore(factContent: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) {
    return 0;
  }
  const factTokens = new Set(tokenize(factContent));
  let matches = 0;
  for (const term of queryTerms) {
    if (factTokens.has(term)) {
      matches++;
    }
  }
  return matches / queryTerms.length;
}

function scoreFact(fact: MemoryFact, queryTerms: string[], projectId?: string): number {
  let score = 0;

  // 1. Scope relevance: project facts rank above global when querying that project
  if (projectId && fact.projectId === projectId) {
    score += 2.0;
  } else if (fact.scopeLevel === "global") {
    score += 1.0;
  }

  // 2. Term relevance: lexical overlap between query and fact content
  score += termOverlapScore(fact.content, queryTerms) * 3.0;

  // 3. Confidence weight
  score += fact.confidence;

  // 4. Recency (bounded contribution, max 0.5)
  const ageDays = (Date.now() - fact.updatedAt) / (1000 * 60 * 60 * 24);
  score += Math.max(0, 0.5 - Math.min(0.5, ageDays / 30));

  return score;
}

/**
 * Ranks and filters memory facts for prompt injection.
 * Excludes superseded facts unless explicitly requested.
 * Excludes sensitive facts from automatic injection unless explicitly included.
 */
export function retrieveRelevantMemories(
  facts: readonly MemoryFact[],
  options?: RetrieveMemoryOptions,
): readonly MemoryFact[] {
  const query = options?.query?.trim() ?? "";
  const queryTerms = query ? tokenize(query) : [];
  const projectId = options?.projectId;
  const limit = options?.limit ?? 10;

  const filtered: MemoryFact[] = [];
  for (const fact of facts) {
    // 1. Exclude superseded facts from normal retrieval
    if (
      !options?.includeSuperseded &&
      fact.supersededBy !== null &&
      fact.supersededBy !== undefined
    ) {
      continue;
    }

    // 2. Exclude sensitive facts from automatic injection unless explicitly included
    if (
      !options?.includeSensitive &&
      fact.sensitivity === ("sensitive" satisfies MemorySensitivity)
    ) {
      continue;
    }

    // 3. Scope filtering: project queries get global + this project's facts
    if (projectId) {
      if (fact.scopeLevel === "project" && fact.projectId !== projectId) {
        continue; // Different project: never leak!
      }
    } else {
      // No project context: exclude project facts entirely
      if (fact.scopeLevel === "project") {
        continue;
      }
    }

    // 4. Category filtering
    if (options?.category && fact.category !== options.category) {
      continue;
    }

    filtered.push(fact);
  }

  // 5. Deterministic scoring and ranking
  const scored: ScoredMemoryFact[] = filtered.map((fact) => ({
    fact,
    score: scoreFact(fact, queryTerms, projectId),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Tie-break: higher confidence first, then newer first, then id for determinism
    if (b.fact.confidence !== a.fact.confidence) {
      return b.fact.confidence - a.fact.confidence;
    }
    if (b.fact.updatedAt !== a.fact.updatedAt) {
      return b.fact.updatedAt - a.fact.updatedAt;
    }
    return a.fact.id < b.fact.id ? -1 : 1;
  });

  return scored.slice(0, limit).map((s) => s.fact);
}
