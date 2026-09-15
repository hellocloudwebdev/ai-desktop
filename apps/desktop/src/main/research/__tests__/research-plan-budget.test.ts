// PR36: apps/desktop — Research Plan + Budget Tests

import { describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_DEPTH_BUDGETS } from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import { buildResearchPlan, normalizeResearchFreshness } from "../research-plan.js";
import { limitParallelism, ResearchBudgetTracker } from "../research-budget.js";
import { ResearchBudgetExceeded, ResearchCancelled } from "../research-errors.js";

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    query: "What are the best open-source LLM coding agents?",
    objectives: ["compare options", "find benchmarks"],
    queries: ["open-source coding agents", "coding agent benchmarks", "GitHub repositories"],
    ...overrides,
  };
}

describe("buildResearchPlan", () => {
  it("builds one step per query with stable step ids", () => {
    const plan = buildResearchPlan(planInput());
    expect(plan.version).toBe(1);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.map((s) => s.stepId)).toEqual(["step-1", "step-2", "step-3"]);
    expect(plan.depth).toBe("standard");
    expect(plan.freshness).toBe("any");
  });

  it("applies depth budgets by default", () => {
    const plan = buildResearchPlan(planInput({ depth: "shallow" }));
    expect(plan.limits).toEqual(DEFAULT_RESEARCH_DEPTH_BUDGETS.shallow);
  });

  it("merges limit overrides over depth defaults", () => {
    const plan = buildResearchPlan(planInput({ limits: { maxSources: 2 } }));
    expect(plan.limits.maxSources).toBe(2);
    expect(plan.limits.maxSearches).toBe(DEFAULT_RESEARCH_DEPTH_BUDGETS.standard.maxSearches);
  });

  it("rejects out-of-range overrides", () => {
    expect(() => buildResearchPlan(planInput({ limits: { maxSources: 500 } }))).toThrow();
  });

  it("rejects empty queries and empty objectives", () => {
    expect(() => buildResearchPlan(planInput({ queries: [] }))).toThrow(ValidationError);
    expect(() => buildResearchPlan(planInput({ objectives: [] }))).toThrow(ValidationError);
  });

  it("rejects more than 16 queries and empty plan query", () => {
    expect(() =>
      buildResearchPlan(planInput({ queries: Array.from({ length: 17 }, (_, i) => `q${i}`) })),
    ).toThrow(ValidationError);
    expect(() => buildResearchPlan(planInput({ query: "  " }))).toThrow(ValidationError);
  });

  it("carries source requirements through", () => {
    const plan = buildResearchPlan(planInput({ sourceRequirements: "prefer official docs" }));
    expect(plan.sourceRequirements).toBe("prefer official docs");
  });
});

describe("normalizeResearchFreshness", () => {
  it("maps provider aliases to canonical freshness", () => {
    expect(normalizeResearchFreshness("24h")).toBe("day");
    expect(normalizeResearchFreshness("past-day")).toBe("day");
    expect(normalizeResearchFreshness("past-week")).toBe("week");
    expect(normalizeResearchFreshness("past-month")).toBe("month");
    expect(normalizeResearchFreshness("past-year")).toBe("year");
    expect(normalizeResearchFreshness("week")).toBe("week");
  });

  it("falls back to any for unknown values", () => {
    expect(normalizeResearchFreshness("someday")).toBe("any");
    expect(normalizeResearchFreshness(undefined)).toBe("any");
    expect(normalizeResearchFreshness(42)).toBe("any");
  });
});

describe("ResearchBudgetTracker", () => {
  it("tracks searches/sources/pages/bytes/chars", () => {
    const tracker = new ResearchBudgetTracker(DEFAULT_RESEARCH_DEPTH_BUDGETS.standard);
    tracker.checkSearch();
    tracker.checkSource();
    tracker.checkPage(100, 50);
    const snap = tracker.snapshot();
    expect(snap.searches).toBe(1);
    expect(snap.sources).toBe(1);
    expect(snap.pages).toBe(1);
    expect(snap.bytes).toBe(100);
    expect(snap.chars).toBe(50);
  });

  it("trips maxSearches", () => {
    const tracker = new ResearchBudgetTracker(DEFAULT_RESEARCH_DEPTH_BUDGETS.shallow);
    tracker.checkSearch();
    expect(() => tracker.checkSearch()).toThrow(ResearchBudgetExceeded);
  });

  it("trips maxSources", () => {
    const tracker = new ResearchBudgetTracker({
      ...DEFAULT_RESEARCH_DEPTH_BUDGETS.standard,
      maxSources: 1,
    });
    tracker.checkSource();
    expect(() => tracker.checkSource()).toThrow(ResearchBudgetExceeded);
  });

  it("trips maxPages, maxBytes, maxCharacters", () => {
    const pages = new ResearchBudgetTracker({
      ...DEFAULT_RESEARCH_DEPTH_BUDGETS.standard,
      maxPages: 1,
    });
    pages.checkPage(10, 10);
    expect(() => pages.checkPage(10, 10)).toThrow(ResearchBudgetExceeded);

    const bytes = new ResearchBudgetTracker({
      ...DEFAULT_RESEARCH_DEPTH_BUDGETS.standard,
      maxBytes: 1024,
    });
    expect(() => bytes.checkPage(2000, 10)).toThrow(ResearchBudgetExceeded);

    const chars = new ResearchBudgetTracker({
      ...DEFAULT_RESEARCH_DEPTH_BUDGETS.standard,
      maxCharacters: 1000,
    });
    expect(() => chars.checkPage(10, 2000)).toThrow(ResearchBudgetExceeded);
  });

  it("trips maxDurationMs", () => {
    const tracker = new ResearchBudgetTracker(
      { ...DEFAULT_RESEARCH_DEPTH_BUDGETS.standard, maxDurationMs: 1000 },
      { startedAt: Date.now() - 60_000 },
    );
    expect(() => tracker.checkSearch()).toThrow(ResearchBudgetExceeded);
  });

  it("reports exhaustion", () => {
    const tracker = new ResearchBudgetTracker(DEFAULT_RESEARCH_DEPTH_BUDGETS.shallow);
    expect(tracker.isExhausted()).toBe(false);
    tracker.checkSearch();
    expect(tracker.isExhausted()).toBe(true);
  });
});

describe("limitParallelism", () => {
  it("preserves input order under concurrency", async () => {
    const result = await limitParallelism([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (4 - n) * 5));
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("bounds concurrency", async () => {
    let live = 0;
    let peak = 0;
    await limitParallelism([1, 2, 3, 4, 5, 6], 2, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates worker errors", async () => {
    await expect(
      limitParallelism([1, 2], 2, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("rejects with ResearchCancelled on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      limitParallelism([1, 2], 2, async (n) => n, controller.signal),
    ).rejects.toBeInstanceOf(ResearchCancelled);
  });
});
