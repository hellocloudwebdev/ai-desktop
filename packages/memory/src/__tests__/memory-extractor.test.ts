import { describe, expect, it } from "vitest";
import { createConversationId } from "@ai-desktop/shared";
import { extractFactsFromMessage } from "../core/memory-extractor.js";

describe("packages/memory: Incremental Extractor (PR28.6)", () => {
  it("extracts high-confidence preference from explicit user statement", () => {
    const facts = extractFactsFromMessage("I use pnpm for all my projects.", {
      sourceConversationId: createConversationId(),
    });

    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe("preference");
    expect(facts[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts instruction from imperative user statement", () => {
    const facts = extractFactsFromMessage("Please remember that code reviews must include tests.", {
      sourceConversationId: createConversationId(),
    });

    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].category).toBe("instruction");
  });

  it("extracts project_context from team statement", () => {
    const facts = extractFactsFromMessage("Our project uses Turborepo with pnpm workspaces.", {
      projectId: "project-alpha",
    });

    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].category).toBe("project_context");
    expect(facts[0].scopeLevel).toBe("project");
    expect(facts[0].projectId).toBe("project-alpha");
  });

  it("ignores short/generic text with no durable signal", () => {
    const facts = extractFactsFromMessage("Hi there!", {});
    expect(facts).toHaveLength(0);
  });

  it("never extracts credentials even from explicit user statements", () => {
    const facts = extractFactsFromMessage(
      "I use sk-ant-api03-1234567890123456789012345678901234567890abcd for auth.",
      {},
    );
    expect(facts).toHaveLength(0);
  });

  it("operates incrementally: each message yields facts independently", () => {
    const first = extractFactsFromMessage("My favorite editor is Zed.", {});
    const second = extractFactsFromMessage("I always run lint before committing.", {});

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].content).not.toBe(second[0].content);
  });
});
