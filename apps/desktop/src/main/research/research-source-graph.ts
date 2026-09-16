// PR36: apps/desktop — Bounded Research Source Graph
//
// Internal relationship model for a single research run: which sources
// duplicate or cite each other, and which sources support or contradict a
// claim. Bounded by construction (max nodes/edges) — this is NOT a general
// knowledge graph and never persists beyond the run.

import { ValidationError } from "@ai-desktop/shared";

export type ResearchGraphNodeKind = "source" | "claim";
export type ResearchGraphRelation = "duplicates" | "cites" | "supports" | "contradicts";

export interface ResearchGraphNode {
  readonly id: string;
  readonly kind: ResearchGraphNodeKind;
  readonly canonicalUrl?: string;
}

export interface ResearchGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: ResearchGraphRelation;
}

export interface ResearchSourceGraphOptions {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

export class ResearchSourceGraph {
  private readonly _maxNodes: number;
  private readonly _maxEdges: number;
  private readonly _nodes = new Map<string, ResearchGraphNode>();
  private readonly _edges: ResearchGraphEdge[] = [];

  constructor(opts?: ResearchSourceGraphOptions) {
    this._maxNodes = Math.max(1, opts?.maxNodes ?? 200);
    this._maxEdges = Math.max(1, opts?.maxEdges ?? 500);
  }

  get nodeCount(): number {
    return this._nodes.size;
  }

  get edgeCount(): number {
    return this._edges.length;
  }

  addSource(sourceId: string, meta?: { canonicalUrl?: string }): void {
    if (!sourceId) {
      throw new ValidationError("Source id must be non-empty");
    }
    const existing = this._nodes.get(sourceId);
    if (existing) {
      if (meta?.canonicalUrl && !existing.canonicalUrl) {
        this._nodes.set(sourceId, { ...existing, canonicalUrl: meta.canonicalUrl });
      }
      return;
    }
    if (this._nodes.size >= this._maxNodes) {
      throw new ValidationError("Research source graph node budget exceeded");
    }
    this._nodes.set(sourceId, {
      id: sourceId,
      kind: "source",
      ...(meta?.canonicalUrl ? { canonicalUrl: meta.canonicalUrl } : {}),
    });
  }

  private _ensureNode(id: string, kind: ResearchGraphNodeKind): void {
    if (this._nodes.has(id)) {
      return;
    }
    if (this._nodes.size >= this._maxNodes) {
      throw new ValidationError("Research source graph node budget exceeded");
    }
    this._nodes.set(id, { id, kind });
  }

  private _addEdge(from: string, to: string, relation: ResearchGraphRelation): void {
    if (this._edges.length >= this._maxEdges) {
      throw new ValidationError("Research source graph edge budget exceeded");
    }
    this._edges.push({ from, to, relation });
  }

  addDuplicateEdge(a: string, b: string): void {
    this._ensureNode(a, "source");
    this._ensureNode(b, "source");
    this._addEdge(a, b, "duplicates");
  }

  addCitesEdge(from: string, to: string): void {
    this._ensureNode(from, "source");
    this._ensureNode(to, "source");
    this._addEdge(from, to, "cites");
  }

  addClaimSupport(claimId: string, sourceId: string): void {
    this._ensureNode(claimId, "claim");
    this._ensureNode(sourceId, "source");
    this._addEdge(sourceId, claimId, "supports");
  }

  addClaimContradiction(claimId: string, sourceId: string): void {
    this._ensureNode(claimId, "claim");
    this._ensureNode(sourceId, "source");
    this._addEdge(sourceId, claimId, "contradicts");
  }

  toJSON(): { nodes: ResearchGraphNode[]; edges: ResearchGraphEdge[] } {
    return {
      nodes: [...this._nodes.values()],
      edges: [...this._edges],
    };
  }
}
