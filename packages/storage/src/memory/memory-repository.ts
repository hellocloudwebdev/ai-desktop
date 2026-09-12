// PR28.5: packages/storage — MemoryRepository Interface
//
// Architectural Scope:
//   - Storage abstraction for durable scoped memory facts.
//   - Zero Prisma imports outside packages/storage.
//   - Retrieval supports global/project scope, category, sensitivity, active/non-superseded filtering.
//   - Raw credentials (API keys, tokens, private keys) are never stored.

export interface StoredMemoryFact {
  readonly id: string;
  readonly scopeLevel: string;
  readonly projectId: string | null;
  readonly content: string;
  readonly category: string;
  readonly sensitivity: string;
  readonly sourceConversationId: string | null;
  readonly confidence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly supersededBy: string | null;
}

export interface CreateMemoryFactData {
  readonly id: string;
  readonly scopeLevel: string;
  readonly projectId?: string | null;
  readonly content: string;
  readonly category: string;
  readonly sensitivity?: string;
  readonly sourceConversationId?: string | null;
  readonly confidence?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ListMemoryFactsQuery {
  readonly projectId?: string;
  readonly scopeLevel?: "global" | "project";
  readonly category?: string;
  readonly sensitivity?: string;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export interface MemoryRepository {
  /**
   * Creates a new import_guard fact.
   */
  createFact(data: CreateMemoryFactData): Promise<StoredMemoryFact>;

  /**
   * Retrieves a import_guard fact by ID.
   */
  getFactById(id: string): Promise<StoredMemoryFact | null>;

  /**
   * Lists import_guard facts scoped to global and optionally a project.
   * Default excludes superseded facts unless includeSuperseded is true.
   */
  listFacts(query?: ListMemoryFactsQuery): Promise<StoredMemoryFact[]>;

  /**
   * Updates fact content, category, sensitivity, or confidence.
   */
  updateFact(
    id: string,
    updates: { content?: string; category?: string; sensitivity?: string; confidence?: number },
  ): Promise<StoredMemoryFact>;

  /**
   * Marks a fact as superseded by another fact (contradiction handling).
   * The superseded fact is kept for history but excluded from default retrieval.
   */
  supersedeFact(id: string, supersededBy: string): Promise<StoredMemoryFact>;

  /**
   * Deletes a import_guard fact by ID.
   */
  deleteFact(id: string): Promise<void>;

  /**
   * Deletes all project-scoped facts for a project (preserves global memory).
   * Returns the number of deleted facts.
   */
  deleteProjectFacts(projectId: string): Promise<number>;
}
