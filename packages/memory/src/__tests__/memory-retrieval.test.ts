import { describe, expect, it } from "vitest";
import { createConversationId, createMemoryFactId } from "@ai-desktop/shared";
import type { MemoryFact } from "@ai-desktop/ai-core";
import { retrieveRelevantMemories } from "../core/memory-retriever.js";

function makeFact(overrides: Partial<MemoryFact>): MemoryFact {
  const ts = Date.now();
  return {
    id: createMemoryFactId(),
    scopeLevel: "global",
    projectId: null,
    content: "User prefers dark mode interfaces.",
    category: "preference",
    sensitivity: "normal",
    sourceConversationId: createConversationId(),
    confidence: 0.9,
    createdAt: ts,
    updatedAt: ts,
    supersededBy: null,
    ...overrides,
  };
}

describe("packages/memory: Deterministic Relevance Retrieval (PR28.7)", () => {
  it("ranks project facts above global facts for the same project", () => {
    const global = makeFact({ content: "User prefers TypeScript for scripting." });
    const project = makeFact({
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "This project uses pnpm with strict peer dependencies.",
    });

    const ranked = retrieveRelevantMemories([global, project], { projectId: "project-alpha" });

    expect(ranked[0].id).toBe(project.id);
  });

  it("excludes superseded facts from default retrieval", () => {
    const old = makeFact({ content: "User's preferred editor is VSCode." });
    const replacement = makeFact({ content: "User's preferred editor is Zed." });
    const superseded = { ...old, supersededBy: replacement.id };

    const ranked = retrieveRelevantMemories([superseded, replacement], {});

    expect(ranked.map((f) => f.id)).not.toContain(old.id);
    expect(ranked.map((f) => f.id)).toContain(replacement.id);
  });

  it("excludes sensitive facts from automatic injection", () => {
    const normal = makeFact({ content: "User uses pnpm for package management." });
    const sensitive = makeFact({
      content: "Salary review cycle is in March.",
      sensitivity: "sensitive",
    });

    const auto = retrieveRelevantMemories([normal, sensitive], {});
    expect(auto.map((f) => f.id)).toContain(normal.id);
    expect(auto.map((f) => f.id)).not.toContain(sensitive.id);

    const explicit = retrieveRelevantMemories([normal, sensitive], { includeSensitive: true });
    expect(explicit.map((f) => f.id)).toContain(sensitive.id);
  });

  it("prevents cross-project leakage in retrieval", () => {
    const projectA = makeFact({
      scopeLevel: "project",
      projectId: "project-A",
      content: "Project A uses React with Vite.",
    });
    const projectB = makeFact({
      scopeLevel: "project",
      projectId: "project-B",
      content: "Project B uses Vue with Nuxt.",
    });

    const rankedA = retrieveRelevantMemories([projectA, projectB], { projectId: "project-A" });
    expect(rankedA.map((f) => f.id)).toContain(projectA.id);
    expect(rankedA.map((f) => f.id)).not.toContain(projectB.id);
  });

  it("orders deterministically: same input always yields identical ranking", () => {
    const ts = Date.now();
    const facts = [
      makeFact({ content: "User prefers pnpm over npm for monorepos.", updatedAt: ts }),
      makeFact({ content: "User reviews code every Friday afternoon.", updatedAt: ts }),
      makeFact({ content: "User writes documentation in Markdown format.", updatedAt: ts }),
    ];

    const first = retrieveRelevantMemories(facts, { query: "pnpm monorepo" });
    const second = retrieveRelevantMemories(facts, { query: "pnpm monorepo" });

    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
  });

  it("respects explicit limit", () => {
    const facts = Array.from({ length: 5 }, (_, i) =>
      makeFact({ content: `Durable workspace note number ${i} about builds.` }),
    );

    const ranked = retrieveRelevantMemories(facts, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });
});
