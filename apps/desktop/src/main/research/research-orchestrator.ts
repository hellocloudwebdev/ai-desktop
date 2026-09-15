// PR36: apps/desktop — Research Orchestrator
//
// Deterministic multi-source research coordination. NOT an agent loop: the
// Agent Runtime supplies sub-queries, and this module executes them with
// bounded budgets through the PR35 ResearchService (cache -> router ->
// adapters, PR34 browser fallback included):
//
//   search() -> dedupe() -> read() -> extract() -> collectEvidence()
//       -> claims -> conflicts -> citations -> synthesis -> package
//
// A failed source degrades to status "partial" with structured errors — it
// never fails the whole run. PR35 cache and PR34 browser boundaries are
// reused untouched.

import {
  createResearchClaimId,
  createResearchPackageId,
  createResearchSourceId,
  createResearchEvidenceId,
  DEFAULT_RESEARCH_DEPTH_BUDGETS,
  type ResearchCanonicalSource,
  type ResearchCitation,
  type ResearchClaim,
  type ResearchConflict,
  type ResearchDepth,
  type ResearchEvidence,
  type ResearchFreshness,
  type ResearchLimits,
  type ResearchPackage,
  type ResearchPackageError,
  type ResearchPlan,
  type ResearchStatus,
  type ResearchSynthesis,
} from "@ai-desktop/ai-core";
import { createResearchRequestId, createTimestamp } from "@ai-desktop/shared";
import { EvidenceExtractor } from "./research-evidence.js";
import { buildResearchCitations, verifyCitationIntegrity } from "./research-citations.js";
import { detectNumericConflicts } from "./research-conflicts.js";
import { buildResearchPlan } from "./research-plan.js";
import { limitParallelism, ResearchBudgetTracker } from "./research-budget.js";
import {
  ResearchCancelled,
  ResearchBudgetExceeded,
  toCanonicalResearchError,
} from "./research-errors.js";
import { canonicalizeSourceUrl, groupSourcesByCanonicalUrl } from "./source-canonicalizer.js";
import { ResearchSourceGraph } from "./research-source-graph.js";
import type { ResearchService } from "./research-service.js";

export interface ResearchOrchestratorDeps {
  readonly researchService: ResearchService;
  readonly projectId?: string;
}

export interface RunDeepResearchInput {
  readonly queries: string[];
  readonly depth?: ResearchDepth;
  readonly freshness?: ResearchFreshness;
  readonly limits?: Partial<ResearchLimits>;
  readonly requestId?: string;
}

export interface RunDeepResearchOptions {
  readonly signal?: AbortSignal;
}

interface CollectedHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly provider: string;
  readonly publishedAt?: string;
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const SOURCE_TYPE_BY_HOST: Array<{ test: RegExp; type: "github" | "video" }> = [
  { test: /(^|\.)github\.com$/i, type: "github" },
  { test: /(^|\.)youtube\.com$/i, type: "video" },
  { test: /(^|\.)youtu\.be$/i, type: "video" },
];

function inferSourceType(url: string): ResearchCanonicalSource["sourceType"] {
  const host = domainOf(url) ?? "";
  for (const rule of SOURCE_TYPE_BY_HOST) {
    if (rule.test.test(host)) {
      return rule.type;
    }
  }
  return "unknown";
}

export class ResearchOrchestrator {
  private readonly _service: ResearchService;
  private readonly _projectId: string;
  private readonly _extractor = new EvidenceExtractor();

  constructor(deps: ResearchOrchestratorDeps) {
    this._service = deps.researchService;
    this._projectId = deps.projectId ?? "default";
  }

  async runDeepResearch(
    input: RunDeepResearchInput,
    options?: RunDeepResearchOptions,
  ): Promise<ResearchPackage> {
    const startedAt = createTimestamp();
    const startedMs = Date.now();
    const requestId =
      typeof input.requestId === "string" && input.requestId
        ? input.requestId
        : createResearchRequestId();
    const depth: ResearchDepth = input.depth ?? "standard";
    const freshness: ResearchFreshness = input.freshness ?? "any";
    const limits: ResearchLimits = {
      ...DEFAULT_RESEARCH_DEPTH_BUDGETS[depth],
      ...input.limits,
    };
    const signal = options?.signal;
    const throwIfCancelled = (): void => {
      if (signal?.aborted) {
        throw new ResearchCancelled();
      }
    };

    const plan: ResearchPlan = buildResearchPlan({
      query: input.queries[0] as string,
      objectives: input.queries.map((q, i) => `Answer sub-query ${i + 1}: ${q}`),
      queries: [...input.queries],
      depth,
      freshness,
      limits,
    });

    const budget = new ResearchBudgetTracker(limits, { startedAt: startedMs });
    const errors: ResearchPackageError[] = [];
    const providersAttempted: string[] = [];
    const retrievalTimestamps: Array<{ label: string; retrievedAt: string }> = [];
    const noteProvider = (provider: string): void => {
      if (!providersAttempted.includes(provider)) {
        providersAttempted.push(provider);
      }
    };

    const serviceCtx = (toolCallId: string) => ({
      projectId: this._projectId,
      toolCallId: toolCallId as never,
      ...(signal ? { signal } : {}),
    });

    try {
      throwIfCancelled();

      // 1. search() — bounded parallel fan-out over Agent-supplied queries.
      const perQueryHits = await limitParallelism(
        plan.steps,
        limits.maxParallelRequests,
        async (step) => {
          budget.checkSearch();
          throwIfCancelled();
          try {
            const results = await this._service.search(
              step.query,
              { limit: Math.min(10, limits.maxSources) },
              serviceCtx(`research-deep-search-${step.stepId}`),
            );
            const hits: CollectedHit[] = results.flatMap((r) => {
              const url = typeof r.url === "string" ? r.url : undefined;
              if (!url) {
                return [];
              }
              noteProvider(r.source.provider);
              return [
                {
                  url,
                  ...(typeof r.title === "string" ? { title: r.title } : {}),
                  ...(typeof r.excerpt === "string" ? { snippet: r.excerpt } : {}),
                  provider: r.source.provider,
                  ...(typeof r.publishedAt === "string" ? { publishedAt: r.publishedAt } : {}),
                },
              ];
            });
            retrievalTimestamps.push({
              label: `search:${step.stepId}`,
              retrievedAt: createTimestamp(),
            });
            return hits;
          } catch (err) {
            if (signal?.aborted || err instanceof ResearchCancelled) {
              throw err;
            }
            const canonical = toCanonicalResearchError(err, "search");
            errors.push({ code: canonical.code, message: canonical.message });
            return [];
          }
        },
        signal,
      );
      const hits = perQueryHits.flat();

      // 2. dedupe() — canonicalize + cross-provider grouping.
      const groups = groupSourcesByCanonicalUrl(
        hits.map((h) => ({
          url: h.url,
          ...(h.title ? { title: h.title } : {}),
          provider: h.provider,
        })),
      );
      const keptGroups = groups.slice(0, limits.maxSources);
      const graph = new ResearchSourceGraph();

      const sources: ResearchCanonicalSource[] = [];
      const groupMeta = new Map<string, CollectedHit[]>();
      for (const group of keptGroups) {
        budget.checkSource();
        const members = hits.filter((h) => {
          try {
            return canonicalizeSourceUrl(h.url) === group.canonicalUrl;
          } catch {
            return false;
          }
        });
        groupMeta.set(group.canonicalUrl, members);
        const firstTitle = group.title ?? members[0]?.title;
        const publishedAt = members.find((m) => m.publishedAt)?.publishedAt;
        const stamp = createTimestamp();
        const sourceId = createResearchSourceId();
        const firstUrl = group.rawUrls[0] as string;
        sources.push({
          sourceId,
          canonicalUrl: group.canonicalUrl,
          rawUrls: group.rawUrls.slice(0, 20),
          ...(firstTitle ? { title: firstTitle.slice(0, 500) } : {}),
          ...(domainOf(group.canonicalUrl) ? { domain: domainOf(group.canonicalUrl) } : {}),
          sourceType: inferSourceType(group.canonicalUrl),
          providers: group.providers.slice(0, 10),
          firstRetrievedAt: stamp,
          lastRetrievedAt: stamp,
          ...(publishedAt ? {} : {}),
        });
        graph.addSource(sourceId, { canonicalUrl: group.canonicalUrl });
        for (const raw of group.rawUrls.slice(1)) {
          void raw;
        }
        void firstUrl;
      }

      // 3. read() + 4. extract() — open each canonical source, bounded.
      const evidence: ResearchEvidence[] = [];
      await limitParallelism(
        sources,
        limits.maxParallelRequests,
        async (source) => {
          throwIfCancelled();
          try {
            const result = await this._service.open(
              source.canonicalUrl,
              { maxChars: Math.min(20000, limits.maxCharacters) },
              serviceCtx(`research-deep-open-${source.sourceId}`),
            );
            const text =
              typeof result.content === "string" ? result.content : (result.excerpt ?? "");
            budget.checkPage(text.length, text.length);
            retrievalTimestamps.push({
              label: `open:${source.sourceId}`,
              retrievedAt: createTimestamp(),
            });
            noteProvider(result.source.provider);
            const snippets = (groupMeta.get(source.canonicalUrl) ?? [])
              .map((m) => m.snippet)
              .filter((s): s is string => typeof s === "string" && s.length > 0)
              .slice(0, 3);
            const queryTerms = [...plan.steps.map((s) => s.query), ...snippets]
              .flatMap((q) => q.toLowerCase().split(/[^a-z0-9]+/))
              .filter((t) => t.length > 3)
              .slice(0, 12);
            const extracted = this._extractor.extract({
              sourceId: source.sourceId,
              text,
              queryTerms,
              requestId,
            });
            for (const item of extracted) {
              evidence.push({
                evidenceId: createResearchEvidenceId(),
                sourceId: item.sourceId as never,
                excerpt: item.excerpt,
                ...(item.locator ? { locator: item.locator } : {}),
                retrievedAt: item.retrievedAt,
                ...(item.requestId ? { requestId: item.requestId } : {}),
              });
            }
            if (extracted.length > 0) {
              graph.addClaimSupport(`claim-from-${source.sourceId}`, source.sourceId);
            }
          } catch (err) {
            if (signal?.aborted || err instanceof ResearchCancelled) {
              throw err;
            }
            if (err instanceof ResearchBudgetExceeded) {
              errors.push({ code: err.code, message: err.message, sourceId: source.sourceId });
              throw err;
            }
            const canonical = toCanonicalResearchError(err, "web");
            errors.push({
              code: canonical.code,
              message: canonical.message,
              sourceId: source.sourceId,
            });
          }
        },
        signal,
      ).catch((err) => {
        if (err instanceof ResearchBudgetExceeded || err instanceof ResearchCancelled) {
          throw err;
        }
        throw err;
      });

      // 5. claims — one extractive claim per evidence item (verbatim text).
      const claims: ResearchClaim[] = evidence.slice(0, 200).map((item) => {
        const claimId = createResearchClaimId();
        graph.addClaimSupport(claimId, item.sourceId);
        return {
          claimId,
          text: item.excerpt.slice(0, 2000),
          evidenceIds: [item.evidenceId],
          sourceIds: [item.sourceId],
        };
      });

      // 6. conflicts — deterministic numeric disagreement detection.
      const claimByEvidence = new Map(claims.map((c) => [c.evidenceIds[0], c.claimId]));
      const conflicts: ResearchConflict[] = detectNumericConflicts(
        evidence.map((item) => ({
          evidenceId: item.evidenceId,
          ...(claimByEvidence.get(item.evidenceId)
            ? { claimId: claimByEvidence.get(item.evidenceId) as string }
            : {}),
          sourceId: item.sourceId,
          excerpt: item.excerpt,
        })),
      ).slice(0, 50);
      for (const conflict of conflicts) {
        for (const id of conflict.claimB.sourceIds) {
          graph.addClaimContradiction(`conflict-${conflict.conflictId}`, id as string);
        }
      }

      // 7. citations + integrity.
      const citations: ResearchCitation[] = buildResearchCitations(sources, evidence).slice(0, 100);
      const integrity = verifyCitationIntegrity({ sources, evidence, claims, citations });
      if (!integrity.ok) {
        errors.push({
          code: "CITATION_INTEGRITY",
          message: `Dangling references: ${JSON.stringify({
            citations: integrity.danglingCitationSourceIds.length,
            evidence: integrity.danglingEvidenceSourceIds.length,
            claimEvidence: integrity.danglingClaimEvidenceIds.length,
            claimSources: integrity.danglingClaimSourceIds.length,
          })}`,
        });
      }

      // 8. synthesis — extractive only: summary references claim order.
      let synthesis: ResearchSynthesis | undefined;
      if (claims.length > 0) {
        const lines = claims.slice(0, 20).map((c, i) => `${i + 1}. ${c.text}`);
        synthesis = {
          summary: `Collected ${evidence.length} evidence excerpts from ${sources.length} sources across ${plan.steps.length} queries. Key findings:\n${lines.join("\n")}`,
          method: "extractive",
          claimIds: claims.slice(0, 20).map((c) => c.claimId),
        };
      }

      const status: ResearchStatus = errors.length === 0 ? "complete" : "partial";
      const finishedAt = createTimestamp();
      void graph;
      return {
        version: 1,
        packageId: createResearchPackageId(),
        requestId,
        plan,
        sources: sources.slice(0, 100),
        evidence: evidence.slice(0, 500),
        claims: claims.slice(0, 200),
        conflicts,
        citations,
        ...(synthesis ? { synthesis } : {}),
        status,
        errors: errors.slice(0, 100),
        provenance: {
          queries: plan.steps.map((s) => s.query).slice(0, 16),
          providersAttempted: providersAttempted.slice(0, 20),
          retrievalTimestamps: retrievalTimestamps.slice(0, 200),
          limits,
          startedAt,
          finishedAt,
        },
      };
    } catch (err) {
      if (signal?.aborted || err instanceof ResearchCancelled) {
        return this._cancelledPackage(requestId, plan, startedAt);
      }
      const canonical = toCanonicalResearchError(err);
      return {
        version: 1,
        packageId: createResearchPackageId(),
        requestId,
        plan,
        sources: [],
        evidence: [],
        claims: [],
        conflicts: [],
        citations: [],
        status: "failed",
        errors: [...errors, { code: canonical.code, message: canonical.message }].slice(0, 100),
        provenance: {
          queries: plan.steps.map((s) => s.query).slice(0, 16),
          providersAttempted: providersAttempted.slice(0, 20),
          retrievalTimestamps: retrievalTimestamps.slice(0, 200),
          limits,
          startedAt,
          finishedAt: createTimestamp(),
        },
      };
    }
  }

  private _cancelledPackage(
    requestId: string,
    plan: ResearchPlan,
    startedAt: string,
  ): ResearchPackage {
    return {
      version: 1,
      packageId: createResearchPackageId(),
      requestId,
      plan,
      sources: [],
      evidence: [],
      claims: [],
      conflicts: [],
      citations: [],
      status: "cancelled",
      errors: [{ code: "CANCELLED", message: "Research operation cancelled" }],
      provenance: {
        queries: plan.steps.map((s) => s.query).slice(0, 16),
        providersAttempted: [],
        retrievalTimestamps: [],
        limits: plan.limits,
        startedAt,
        finishedAt: createTimestamp(),
      },
    };
  }
}
