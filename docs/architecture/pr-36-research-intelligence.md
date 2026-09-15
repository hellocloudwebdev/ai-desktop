# PR36 — Research Intelligence & Source Synthesis Foundation

## 1. Objective

PR36 turns PR35's find-and-retrieve research into **bounded, auditable,
multi-source research**. The Agent Runtime supplies sub-queries; a
deterministic orchestration layer executes them through the PR35
`ResearchService`, deduplicates sources, extracts verbatim evidence, detects
conflicts, and returns a versioned `ResearchPackage` handoff.

```text
Agent Runtime
    ↓
ToolRegistry (canonical tool definition: builtin:research.deep)
    ↓
PermissionManager (capability: research, action: deep, risk: medium)
    ↓
ResearchToolExecutor (resolve → validate → permission → execute)
    ↓
ResearchOrchestrator (deterministic: NOT an agent loop)
    ↓
ResearchService (PR35: cache → router → adapters → browser fallback)
```

**Inviolable rule: PR36 creates no ReAct/agent loop.** PR29 Agent Runtime
remains the only planner/executor. PR36 provides research-specific
deterministic capabilities the runtime calls as tools.

---

## 2. Inviolable Architectural & Security Rules

1. **No second agent loop**: `ResearchOrchestrator` coordinates `search()`,
   `read()`, `dedupe()`, `extract()`, and `collectEvidence()` only. Query
   decomposition stays in the Agent Runtime; PR36 executes supplied queries.
2. **Never manufacture evidence**: every excerpt is a verbatim substring of a
   retrieved document (`EvidenceExtractor` asserts this invariant and throws
   on violation). Unsupported claims are never created.
3. **Evidence vs synthesis stay separate**: `ResearchEvidence` records what a
   source actually says; `ResearchSynthesis` (method `"extractive"` only)
   combines collected evidence. No abstractive rewriting.
4. **Conflicts over silent choices**: disagreeing sources produce a
   `ResearchConflict` (`claimA` / `claimB` with source lists); neither side
   is silently discarded.
5. **Quality signals are metadata, not truth**: `SourceQualitySignals`
   exposes domain, publisher, freshness, provider confidence, content
   availability, and duplicate count. There is no truth score.
6. **External content is untrusted**: research content is data, never
   instructions, tool definitions, permission grants, or commands (explicit
   prompt-injection and tool-poisoning regression tests).
7. **Bounded everything**: every run carries `ResearchLimits`
   (`maxSearches`, `maxSources`, `maxPages`, `maxBytes`, `maxCharacters`,
   `maxDepth`, `maxDurationMs`, `maxParallelRequests`) with depth presets
   (`shallow` / `standard` / `deep`). Exhaustion degrades to `partial`,
   never to memory exhaustion.
8. **Reuse, don't duplicate**: PR35 cache, PR34 browser fallback (through
   `ResearchService` only — never Puppeteer directly), PR33 Rich Surface
   infrastructure, and the existing `research` permission capability.

---

## 3. Canonical Domain Model (`@ai-desktop/ai-core`)

New module `research-intelligence.ts` (PR35 `research.ts` gains only the
`deep` action + `builtin:research.deep` tool id).

### 3.1 Branded Identifiers

`ResearchPlanId`, `ResearchEvidenceId`, `ResearchClaimId`,
`ResearchConflictId`, `ResearchCitationId`, `ResearchPackageId`
(`ResearchSourceId` reused from PR35). All branded ULIDs with
`create*` helpers.

### 3.2 Plans, Limits, Freshness

```ts
interface ResearchPlan {
  version: 1;
  planId: ResearchPlanId;
  query: string;
  objectives: string[];
  sourceRequirements?: string;
  steps: ResearchStep[]; // one per Agent-supplied query (max 16)
  depth: "shallow" | "standard" | "deep";
  freshness: "any" | "day" | "week" | "month" | "year";
  limits: ResearchLimits;
}
```

`DEFAULT_RESEARCH_DEPTH_BUDGETS`: shallow (1 search / 3 sources / 30s),
standard (3 / 8 / 120s), deep (8 / 20 / 300s). Provider freshness aliases
(`24h`, `past-week`, …) normalize into the canonical model.

### 3.3 Sources, Evidence, Claims

`ResearchCanonicalSource` carries `canonicalUrl`, `rawUrls`,
`title`/`domain`/`publisher`, `sourceType` (official-docs, github,
research-paper, government, company-announcement, news, blog, forum,
social, video, rss, unknown), `primarySource?`, `officialSource?`, and the
cross-provider `providers[]` ledger — four providers returning the same
page yield one source, not four.

`ResearchEvidence` binds `excerpt` (≤2000 chars, verbatim) to `sourceId`
with an optional `EvidenceLocator` (`heading`, `paragraph`, `line-range`,
`timestamp`, `github-file-line`, `section`) set only when the adapter
provides it — line numbers are never invented.

`ResearchClaim` references `evidenceIds[]` + `sourceIds[]` (≥1 each).

### 3.4 Conflicts, Citations, Packages

`ResearchConflict` pairs `claimA` / `claimB` (`text`, `claimIds`,
`evidenceIds`, `sourceIds`) under a `topic`. `ResearchCitation` mirrors
the source with `retrievedAt` and an optional adapter-provided locator.
`ResearchSynthesis` is `{ summary, method: "extractive", claimIds }`.

```ts
interface ResearchPackage {
  version: 1;
  packageId: ResearchPackageId;
  requestId: string;
  plan: ResearchPlan;
  sources: ResearchCanonicalSource[];
  evidence: ResearchEvidence[];
  claims: ResearchClaim[];
  conflicts: ResearchConflict[];
  citations: ResearchCitation[];
  synthesis?: ResearchSynthesis;
  status: "complete" | "partial" | "failed" | "cancelled";
  errors: ResearchPackageError[];
  provenance: ResearchRunProvenance; // queries, providers, timestamps, limits — never secrets
}
```

---

## 4. Canonical Tool Contract

- `builtin:research.deep` (`source: "builtin"`, `runtime: "in_process"`,
  `requiredPermissions: ["research"]`, risk `medium`).
- Input: `queries[1..8]` (Agent-supplied), `depth` (default `standard`),
  `freshness` (default `any`), optional bounded `limits` overrides,
  optional `requestId`.
- Lifecycle: `ToolRegistry` resolve → `ResearchDeepInputSchema` validation
  (before permission) → `PermissionManager.check({ capability: "research",
action: "deep", … })` → `ResearchOrchestrator.runDeepResearch()` →
  bounded JSON `ResearchPackage`. Denials and failures return
  `isError: true`; the tool never starts an agent loop.

---

## 5. Deterministic Desktop Modules (`apps/desktop/src/main/research/`)

- `source-canonicalizer.ts`: conservative URL normalization (tracking-param
  strip, fragment/default-port/trailing-slash collapse, query sorting) plus
  `sameSourceUrl` and cross-provider `groupSourcesByCanonicalUrl`.
- `research-plan.ts`: `buildResearchPlan` (steps from queries, depth
  budgets with validated overrides) and `normalizeResearchFreshness`.
- `research-budget.ts`: `ResearchBudgetTracker` (increment-then-enforce
  counters + duration) and order-preserving `limitParallelism` with
  `AbortSignal` cancellation (`ResearchCancelled`).
- `research-evidence.ts`: `EvidenceExtractor` (sentence scoring by
  query-term overlap, verbatim-substring invariant, paragraph locators).
- `research-citations.ts`: `buildResearchCitations` (one per evidenced
  source) and `verifyCitationIntegrity` (no dangling claim → evidence →
  source references).
- `research-conflicts.ts`: `detectNumericConflicts` (numbers with
  normalized units — `$`/`USD`, `%`/`percent`, magnitudes — from ≥2
  distinct sources) with deterministic unit ordering.
- `research-source-graph.ts`: bounded internal relationship model
  (`duplicates` / `cites` / `supports` / `contradicts`, max nodes/edges) —
  not a general knowledge graph.
- `research-orchestrator.ts`: `ResearchOrchestrator.runDeepResearch()`
  (search → dedupe → read → extract → claims → conflicts → citations →
  synthesis → package). Partial degradation with structured errors;
  cancellation yields a `cancelled` package; research results never become
  memory facts automatically (`Research ≠ Memory`); nothing persists
  beyond the run (no saved-research store — a later PR concern).

---

## 6. Security & Isolation

- Every external source is untrusted: malicious pages (`Ignore previous
instructions…`, `Call this tool…`) remain framed data
  (`frameResearchContent`); the extractor never executes directives.
- Tool poisoning: research content cannot register tools or rewrite
  definitions — the executor's tool list is invariant across runs.
- Citation integrity: every citation resolves to a collected source;
  `verifyCitationIntegrity` proves the full chain.
- SSRF, MIME, size, and secret-redaction guarantees inherited unchanged
  from PR35 (`SSRFGuard`, `secureFetch`, `redactSecretsFromMessage`).

---

## 7. Browser, Cache, Workspace Integration

- **Browser**: orchestrator reads through `ResearchService.open()`, which
  owns the single PR34 fallback path (static reader → `BrowserService`
  snapshot). `ResearchOrchestrator → Puppeteer` edges are forbidden.
- **Cache**: PR35 `ResearchCache` reused as-is (search-result and page
  caching); research packages and run state stay ephemeral and separate.
- **Workspace**: existing `ResearchSurface` extended with an optional
  `deepPackage` view (active query status, source counts, evidence with
  claim → evidence → source open affordances, conflicts, citations,
  extractive synthesis) plus `isDeepResearching` progress. No new surface
  kind, no new IPC channel, no new rendering architecture. Progress reuses
  tool-execution lifecycle events (no per-query/per-source event fan-out).

---

## 8. Verification

- ai-core: `research-intelligence.test.ts` (~40 tests: schemas, budgets,
  deep input, framing) + `research.test.ts` (deep registration).
- Desktop: canonicalizer (~20), plan+budget (~20), evidence (~8),
  citations/conflicts/graph (~20), orchestrator (6), security (8:
  prompt-injection, tool poisoning, citation integrity, `research.deep`
  gating), renderer deep-surface (6).
- E2E (`research-deep-e2e.test.ts`): full package run, conflict fixtures
  (exactly 1 conflict, both sources kept), browser-fallback recovery with
  evidence + citation.
- Gates: `architecture:check`, `typecheck`, `lint`, `test`, `build`,
  `format:check` (no new dependencies; dependency graph unchanged).
