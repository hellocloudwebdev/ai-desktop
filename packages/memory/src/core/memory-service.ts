// PR28.5–PR28.10: packages/memory — Memory Service (facts, supersession, context builder)
//
// Invariants:
//   1. CRUD over MemoryRepository in packages/storage; memory never imports Prisma.
//   2. Contradiction handling via supersededBy reference (never silently deleted).
//   3. Project isolation: project queries include global + own project facts only.
//   4. Project deletion archives/removes project facts while global memory survives.
//   5. Bounded injection: explicit maxFacts and maxCharacters limits.
//   6. Sensitive facts filtered from automatic injection unless explicitly included.
//   7. Raw credentials rejected before persistence (§PR28.12).

import {
  containsRawCredential,
  createMemoryFactId,
  MemoryFactSchema,
  type CreateMemoryFactInput,
  type MemoryCategory,
  type MemoryFact,
  type MemoryFactId,
  type MemoryScopeLevel,
  type MemorySensitivity,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import type { MemoryRepository } from "@ai-desktop/storage";
import { retrieveRelevantMemories, type RetrieveMemoryOptions } from "./memory-retriever.js";

export interface MemoryServiceOptions {
  readonly repository: MemoryRepository;
  readonly defaultMaxFacts?: number;
  readonly defaultMaxCharacters?: number;
  memoryInjectionEnabled?: boolean;
}

export interface BuildMemoryContextOptions {
  readonly projectId?: string;
  readonly query?: string;
  readonly category?: string;
  readonly includeSensitive?: boolean;
  readonly maxFacts?: number;
  readonly maxCharacters?: number;
}

export interface MemoryContextSection {
  readonly facts: readonly MemoryFact[];
  readonly characters: number;
  readonly truncated: boolean;
}

export class MemoryService {
  private readonly _repository: MemoryRepository;
  private readonly _defaultMaxFacts: number;
  private readonly _defaultMaxCharacters: number;
  private _injectionEnabled: boolean;

  constructor(options: MemoryServiceOptions) {
    this._repository = options.repository;
    this._defaultMaxFacts = options.defaultMaxFacts ?? 10;
    this._defaultMaxCharacters = options.defaultMaxCharacters ?? 4000;
    this._injectionEnabled = options.memoryInjectionEnabled ?? true;
  }

  get injectionEnabled(): boolean {
    return this._injectionEnabled;
  }

  setInjectionEnabled(enabled: boolean): void {
    this._injectionEnabled = enabled;
  }

  /**
   * Creates and persists a new import_guard fact after validation.
   */
  async createFact(input: CreateMemoryFactInput): Promise<MemoryFact> {
    const id = input.id ?? createMemoryFactId();
    const ts = Date.now();

    const candidate = {
      id,
      scopeLevel: input.scopeLevel satisfies MemoryScopeLevel,
      projectId: input.scopeLevel === "project" ? (input.projectId ?? null) : null,
      content: input.content,
      category: input.category satisfies MemoryCategory,
      sensitivity: input.sensitivity ?? ("normal" satisfies MemorySensitivity),
      sourceConversationId: input.sourceConversationId ?? null,
      confidence: input.confidence ?? 1.0,
      createdAt: ts,
      updatedAt: ts,
      supersededBy: null,
      metadata: input.metadata,
    };

    const parsed = MemoryFactSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(`Invalid import_guard fact: ${issues}`);
    }

    const stored = await this._repository.createFact({
      id: parsed.data.id,
      scopeLevel: parsed.data.scopeLevel,
      projectId: parsed.data.projectId,
      content: parsed.data.content,
      category: parsed.data.category,
      sensitivity: parsed.data.sensitivity,
      sourceConversationId: parsed.data.sourceConversationId,
      confidence: parsed.data.confidence,
      createdAt: parsed.data.createdAt,
      updatedAt: parsed.data.updatedAt,
    });

    return {
      id: stored.id as MemoryFactId,
      scopeLevel: stored.scopeLevel as MemoryScopeLevel,
      projectId: stored.projectId,
      content: stored.content,
      category: stored.category as MemoryCategory,
      sensitivity: stored.sensitivity as MemorySensitivity,
      sourceConversationId: stored.sourceConversationId as MemoryFact["sourceConversationId"],
      confidence: stored.confidence,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      supersededBy: stored.supersededBy as MemoryFact["supersededBy"],
    };
  }

  /**
   * Retrieves a import_guard fact by ID.
   */
  async getFactById(id: MemoryFactId): Promise<MemoryFact | null> {
    const stored = await this._repository.getFactById(id);
    if (!stored) {
      return null;
    }
    return {
      id: stored.id as MemoryFactId,
      scopeLevel: stored.scopeLevel as MemoryScopeLevel,
      projectId: stored.projectId,
      content: stored.content,
      category: stored.category as MemoryCategory,
      sensitivity: stored.sensitivity as MemorySensitivity,
      sourceConversationId: stored.sourceConversationId as MemoryFact["sourceConversationId"],
      confidence: stored.confidence,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      supersededBy: stored.supersededBy as MemoryFact["supersededBy"],
    };
  }

  /**
   * Updates fact content, category, sensitivity, or confidence.
   */
  async updateFact(
    id: MemoryFactId,
    updates: {
      content?: string;
      category?: MemoryCategory;
      sensitivity?: MemorySensitivity;
      confidence?: number;
    },
  ): Promise<MemoryFact> {
    if (updates.content !== undefined && containsRawCredential(updates.content)) {
      throw new ValidationError(
        "Raw credentials are strictly forbidden in import_guard facts (§PR28.12)",
      );
    }

    const stored = await this._repository.updateFact(id, {
      content: updates.content,
      category: updates.category,
      sensitivity: updates.sensitivity,
      confidence: updates.confidence,
    });

    return {
      id: stored.id as MemoryFactId,
      scopeLevel: stored.scopeLevel as MemoryScopeLevel,
      projectId: stored.projectId,
      content: stored.content,
      category: stored.category as MemoryCategory,
      sensitivity: stored.sensitivity as MemorySensitivity,
      sourceConversationId: stored.sourceConversationId as MemoryFact["sourceConversationId"],
      confidence: stored.confidence,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      supersededBy: stored.supersededBy as MemoryFact["supersededBy"],
    };
  }

  /**
   * Handles contradiction: marks existing fact as superseded by a replacing fact.
   * Both facts remain inspectable; retrieval defaults to the replacing fact.
   */
  async supersedeFact(id: MemoryFactId, supersededBy: MemoryFactId): Promise<MemoryFact> {
    const stored = await this._repository.supersedeFact(id, supersededBy);
    return {
      id: stored.id as MemoryFactId,
      scopeLevel: stored.scopeLevel as MemoryScopeLevel,
      projectId: stored.projectId,
      content: stored.content,
      category: stored.category as MemoryCategory,
      sensitivity: stored.sensitivity as MemorySensitivity,
      sourceConversationId: stored.sourceConversationId as MemoryFact["sourceConversationId"],
      confidence: stored.confidence,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      supersededBy: stored.supersededBy as MemoryFact["supersededBy"],
    };
  }

  /**
   * Deletes a import_guard fact by ID.
   */
  async deleteFact(id: MemoryFactId): Promise<void> {
    await this._repository.deleteFact(id);
  }

  /**
   * Deletes all project-scoped facts for a project; global memory survives.
   */
  async deleteProjectFacts(projectId: string): Promise<number> {
    return this._repository.deleteProjectFacts(projectId);
  }

  /**
   * Searches memory facts with project isolation and deterministic relevance ranking.
   */
  async searchMemories(options?: RetrieveMemoryOptions): Promise<readonly MemoryFact[]> {
    const stored = await this._repository.listFacts({
      projectId: options?.projectId,
      category: options?.category,
      includeSuperseded: options?.includeSuperseded ?? false,
    });

    const facts: MemoryFact[] = stored.map((s) => ({
      id: s.id as MemoryFactId,
      scopeLevel: s.scopeLevel as MemoryScopeLevel,
      projectId: s.projectId,
      content: s.content,
      category: s.category as MemoryCategory,
      sensitivity: s.sensitivity as MemorySensitivity,
      sourceConversationId: s.sourceConversationId as MemoryFact["sourceConversationId"],
      confidence: s.confidence,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      supersededBy: s.supersededBy as MemoryFact["supersededBy"],
    }));

    return retrieveRelevantMemories(facts, options);
  }

  /**
   * Builds a bounded import_guard context section for prompt injection.
   * When injection is disabled, returns empty content while facts remain stored.
   * Sensitive facts are excluded from automatic injection unless explicitly included.
   */
  async buildMemoryContext(options?: BuildMemoryContextOptions): Promise<MemoryContextSection> {
    if (!this._injectionEnabled) {
      return { facts: [], characters: 0, truncated: false };
    }

    const maxFacts = options?.maxFacts ?? this._defaultMaxFacts;
    const maxCharacters = options?.maxCharacters ?? this._defaultMaxCharacters;

    const candidates = await this.searchMemories({
      projectId: options?.projectId,
      query: options?.query,
      category: options?.category,
      includeSensitive: options?.includeSensitive ?? false,
      limit: maxFacts,
    });

    const selected: MemoryFact[] = [];
    let characters = 0;
    let truncated = false;

    for (const fact of candidates) {
      if (selected.length >= maxFacts) {
        truncated = true;
        break;
      }
      const factChars = fact.content.length + 4; // "- " prefix + newline
      if (characters + factChars > maxCharacters) {
        truncated = true;
        break;
      }
      selected.push(fact);
      characters += factChars;
    }

    return { facts: selected, characters, truncated };
  }

  /**
   * Formats import_guard context facts as prompt-ready text with scope attribution.
   */
  formatMemoryContext(section: MemoryContextSection): string {
    if (section.facts.length === 0) {
      return "";
    }
    const lines = section.facts.map((f) => {
      const scope = f.scopeLevel === "project" ? `project:${f.projectId ?? "?"}` : "global";
      return `- [${scope}/${f.category}] ${f.content}`;
    });
    return `Relevant memory:\n${lines.join("\n")}`;
  }
}
