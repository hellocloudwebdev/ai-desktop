// PR36: apps/desktop — Research Plan Builder
//
// Builds a deterministic ResearchPlan from Agent-supplied sub-queries.
// PR36 never generates queries with an LLM: the Agent Runtime decomposes the
// question, and this module structures the steps and applies bounded budgets.

import {
  createResearchPlanId,
  DEFAULT_RESEARCH_DEPTH_BUDGETS,
  ResearchLimitsSchema,
  type ResearchDepth,
  type ResearchFreshness,
  type ResearchLimits,
  type ResearchPlan,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";

export interface BuildResearchPlanInput {
  readonly query: string;
  readonly objectives: string[];
  readonly queries: string[];
  readonly depth?: ResearchDepth;
  readonly freshness?: ResearchFreshness;
  readonly limits?: Partial<ResearchLimits>;
  readonly sourceRequirements?: string;
}

export function buildResearchPlan(input: BuildResearchPlanInput): ResearchPlan {
  if (!input.query?.trim()) {
    throw new ValidationError("Research plan query must be non-empty");
  }
  if (!input.objectives || input.objectives.length < 1 || input.objectives.length > 10) {
    throw new ValidationError("Research plan requires 1-10 objectives");
  }
  if (!input.queries || input.queries.length < 1 || input.queries.length > 16) {
    throw new ValidationError("Research plan requires 1-16 queries");
  }
  const depth = input.depth ?? "standard";
  const freshness = input.freshness ?? "any";
  const merged = { ...DEFAULT_RESEARCH_DEPTH_BUDGETS[depth], ...input.limits };
  const limits = ResearchLimitsSchema.parse(merged);
  return {
    version: 1,
    planId: createResearchPlanId(),
    query: input.query,
    objectives: [...input.objectives],
    ...(input.sourceRequirements ? { sourceRequirements: input.sourceRequirements } : {}),
    steps: input.queries.map((query, index) => ({
      stepId: `step-${index + 1}`,
      query,
      purpose: `Answer sub-query ${index + 1}`,
    })),
    depth,
    freshness,
    limits,
  };
}

const FRESHNESS_ALIASES: Record<string, ResearchFreshness> = {
  "24h": "day",
  "past-day": "day",
  day: "day",
  "past-week": "week",
  week: "week",
  "past-month": "month",
  month: "month",
  "past-year": "year",
  year: "year",
  any: "any",
};

/** Normalize provider-specific freshness values into the canonical model. */
export function normalizeResearchFreshness(value: unknown): ResearchFreshness {
  if (typeof value !== "string") {
    return "any";
  }
  return FRESHNESS_ALIASES[value.trim().toLowerCase()] ?? "any";
}
