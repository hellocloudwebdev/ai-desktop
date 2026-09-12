import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-desktop/shared";
import { MemoryService } from "../core/memory-service.js";
import type {
  CreateMemoryFactData,
  ListMemoryFactsQuery,
  MemoryRepository,
  StoredMemoryFact,
} from "@ai-desktop/storage";

class InMemoryMemoryRepository implements MemoryRepository {
  private readonly _facts = new Map<string, StoredMemoryFact>();

  async createFact(data: CreateMemoryFactData): Promise<StoredMemoryFact> {
    const fact: StoredMemoryFact = {
      id: data.id,
      scopeLevel: data.scopeLevel,
      projectId: data.projectId ?? null,
      content: data.content,
      category: data.category,
      sensitivity: data.sensitivity ?? "normal",
      sourceConversationId: data.sourceConversationId ?? null,
      confidence: data.confidence ?? 1.0,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      supersededBy: null,
    };
    this._facts.set(data.id, fact);
    return fact;
  }

  async getFactById(id: string): Promise<StoredMemoryFact | null> {
    return this._facts.get(id) ?? null;
  }

  async listFacts(query?: ListMemoryFactsQuery): Promise<StoredMemoryFact[]> {
    return [...this._facts.values()].filter((f) => {
      if (query?.projectId !== undefined) {
        if (!(f.scopeLevel === "global" || f.projectId === query.projectId)) return false;
      } else if (query?.scopeLevel === undefined && f.scopeLevel === "project") {
        return false;
      }
      if (query?.scopeLevel !== undefined && f.scopeLevel !== query.scopeLevel) return false;
      if (query?.category !== undefined && f.category !== query.category) return false;
      if (query?.sensitivity !== undefined && f.sensitivity !== query.sensitivity) return false;
      if (!query?.includeSuperseded && f.supersededBy !== null) return false;
      return true;
    });
  }

  async updateFact(
    id: string,
    updates: { content?: string; category?: string; sensitivity?: string; confidence?: number },
  ): Promise<StoredMemoryFact> {
    const existing = this._facts.get(id);
    if (!existing) throw new Error(`Memory fact "${id}" not found`);
    const updated: StoredMemoryFact = {
      ...existing,
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.category !== undefined && { category: updates.category }),
      ...(updates.sensitivity !== undefined && { sensitivity: updates.sensitivity }),
      ...(updates.confidence !== undefined && { confidence: updates.confidence }),
      updatedAt: Date.now(),
    };
    this._facts.set(id, updated);
    return updated;
  }

  async supersedeFact(id: string, supersededBy: string): Promise<StoredMemoryFact> {
    const existing = this._facts.get(id);
    if (!existing) throw new Error(`Memory fact "${id}" not found`);
    const updated: StoredMemoryFact = { ...existing, supersededBy, updatedAt: Date.now() };
    this._facts.set(id, updated);
    return updated;
  }

  async deleteFact(id: string): Promise<void> {
    this._facts.delete(id);
  }

  async deleteProjectFacts(projectId: string): Promise<number> {
    let count = 0;
    for (const [id, f] of this._facts.entries()) {
      if (f.scopeLevel === "project" && f.projectId === projectId) {
        this._facts.delete(id);
        count++;
      }
    }
    return count;
  }
}

describe("packages/memory: MemoryService Lifecycle (PR28.5–PR28.10)", () => {
  it("creates, retrieves, updates, and deletes facts through the repository", async () => {
    const service = new MemoryService({ repository: new InMemoryMemoryRepository() });

    const fact = await service.createFact({
      scopeLevel: "global",
      content: "User prefers pnpm for package management.",
      category: "preference",
      confidence: 0.95,
    });
    expect(fact.id).toBeDefined();
    expect(fact.scopeLevel).toBe("global");

    const retrieved = await service.getFactById(fact.id);
    expect(retrieved?.content).toBe(fact.content);

    const updated = await service.updateFact(fact.id, { confidence: 0.8 });
    expect(updated.confidence).toBe(0.8);

    await service.deleteFact(fact.id);
    expect(await service.getFactById(fact.id)).toBeNull();
  });

  it("rejects raw credentials at creation time", async () => {
    const service = new MemoryService({ repository: new InMemoryMemoryRepository() });

    await expect(
      service.createFact({
        scopeLevel: "global",
        content: "My token is sk-ant-api03-1234567890123456789012345678901234567890abcd",
        category: "fact",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("handles contradiction: superseded fact excluded, replacement retrieved", async () => {
    const service = new MemoryService({ repository: new InMemoryMemoryRepository() });

    const oldFact = await service.createFact({
      scopeLevel: "global",
      content: "User's preferred editor is VSCode.",
      category: "preference",
    });
    const newFact = await service.createFact({
      scopeLevel: "global",
      content: "User's preferred editor is Zed.",
      category: "preference",
    });

    await service.supersedeFact(oldFact.id, newFact.id);

    const results = await service.searchMemories({});
    expect(results.map((f) => f.id)).not.toContain(oldFact.id);
    expect(results.map((f) => f.id)).toContain(newFact.id);
  });

  it("builds bounded import_guard context with character ceiling and attribution", async () => {
    const service = new MemoryService({
      repository: new InMemoryMemoryRepository(),
      defaultMaxFacts: 2,
      defaultMaxCharacters: 80,
    });

    await service.createFact({
      scopeLevel: "global",
      content: "User prefers pnpm for monorepos.",
      category: "preference",
    });
    await service.createFact({
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "Project Alpha uses Turborepo builds.",
      category: "project_context",
    });
    await service.createFact({
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "Project Alpha lints before every commit.",
      category: "workflow",
    });

    const section = await service.buildMemoryContext({ projectId: "project-alpha" });
    expect(section.facts.length).toBeLessThanOrEqual(2);
    expect(section.characters).toBeLessThanOrEqual(80);

    const text = service.formatMemoryContext(section);
    expect(text).toContain("Relevant memory:");
    expect(text).toContain("project:project-alpha");
  });

  it("supports injection disable: facts remain stored but nothing is injected", async () => {
    const service = new MemoryService({ repository: new InMemoryMemoryRepository() });

    await service.createFact({
      scopeLevel: "global",
      content: "User prefers dark mode interfaces.",
      category: "preference",
    });

    service.setInjectionEnabled(false);
    const section = await service.buildMemoryContext({});
    expect(section.facts).toHaveLength(0);
    expect(service.formatMemoryContext(section)).toBe("");

    // Fact is still stored
    const results = await service.searchMemories({});
    expect(results).toHaveLength(1);
  });

  it("deletes project facts on project deletion while global memory survives", async () => {
    const service = new MemoryService({ repository: new InMemoryMemoryRepository() });

    await service.createFact({
      scopeLevel: "project",
      projectId: "project-doomed",
      content: "Doomed project build convention.",
      category: "project_context",
    });
    await service.createFact({
      scopeLevel: "global",
      content: "User prefers TypeScript strict mode.",
      category: "preference",
    });

    const deleted = await service.deleteProjectFacts("project-doomed");
    expect(deleted).toBe(1);

    const remaining = await service.searchMemories({ includeSuperseded: true });
    expect(remaining.map((f) => f.content)).toContain("User prefers TypeScript strict mode.");
    expect(remaining.map((f) => f.id)).not.toContain(
      (await service.searchMemories({})).find((f) => f.projectId === "project-doomed")?.id,
    );
  });
});
