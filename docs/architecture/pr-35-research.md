# PR35 — Web Research & Internet Connectivity Foundation

## Objective

PR35 gives the existing Agent Runtime safe, structured internet research
capabilities without turning Browser Automation (PR34) into the research
abstraction:

```text
Agent Runtime
    ↓
DesktopToolRouter (builtin:research.* → ResearchToolExecutor)
    ↓
ResearchToolExecutor (resolve → validate → permission → execute)
    ↓
ResearchService (cache → router → adapters, browser fallback when needed)
    ↓
ResearchRouter (channel → primary adapter → fallback adapter)
    ↓
Adapters (web / search / github / youtube / rss) → external web/API source
```

Browser automation remains a separate capability. A research adapter may fall
back to the PR34 Browser subsystem when static retrieval is insufficient, but
only through the existing `BrowserService` boundary — research never imports
Puppeteer, never calls `BrowserManager` directly from the Agent Runtime, and
never spawns arbitrary subprocesses.

## Third-party policy (Agent-Reach decision)

Agent-Reach (Panniantong) is a **conceptual reference only** for channel
abstraction, provider routing, fallback, provenance, health, bounds, and
caching. It is explicitly **not** a dependency, not a fork, and not embedded:

- No `Agent-Reach` package in any `package.json`.
- No Python/CLI installer code imported or shelled out to.
- No model-driven package installation (`pip install`, `npm install`,
  `brew install`, `curl | sh`) anywhere in the research path.
- No research adapter mutates the host (no installs, no profile imports,
  no filesystem writes outside bounded temp artifacts owned by the host).
- `dev-browser` / `ego-lite` remain PR34-era references only.

Rationale: the upstream project is a shifting collection of channel backends
with a known audit history around installers, subprocess execution, browser
profile access, and credential handling. PR35 keeps host control over
installation, credentials, subprocesses, and browser access by owning its
adapters outright.

## Package placement

No new package. Mirrors the PR34 split:

- `packages/ai-core/src/research.ts` — canonical contracts only (branded IDs,
  channels, sources, provenance, results, tool definitions, capability/risk
  maps, ceilings, pure URL/canonicalization helpers). Zero Electron, Prisma,
  network, DNS, or vendor SDK code.
- `apps/desktop/src/main/research/` — privileged implementation (fetch,
  DNS-backed SSRF guard, adapters, cache, service, executor).
- Research ID brands (`ResearchRequestId`, `ResearchSourceId`,
  `ResearchResultId`, `ResearchDocumentId`) live in
  `packages/ai-core/src/identifiers.ts` alongside the browser ID precedent.
  `ToolCallId` is never reused as research entity identity.

`desktop → {ai-core, permissions, shared, storage}` edges already exist and
are declared; no `dependency-graph.json` / `package.json` changes are needed
because PR35 adds **zero new external dependencies** (Node 22 global `fetch`

- `node:dns` + hand-rolled bounded parsers behind adapter boundaries).

## Canonical research model

Branded ULID identifiers (never `ToolCallId`):

- `ResearchRequestId`, `ResearchSourceId`, `ResearchResultId`,
  `ResearchDocumentId`

Closed channel vocabulary (do not extend without concrete need):

- `web`, `search`, `github`, `youtube`, `rss`

Providers are an open string with well-known constants (`static-reader`,
`jina`, `exa`, `github-api`, `youtube-oembed`, `youtube-api`, `rss`,
`browser`, …) so new backends register without contract churn.

`ResearchSource`:

- `id`, `channel`, `provider`, `url?`, `title?`, `retrievedAt`,
  `publishedAt?`, `contentType?`, `provenance`

`ResearchProvenance` answers where/how/when:

- `provider` (successful), `attemptedProviders` (full fallback trail),
  `channel`, `url?`, `retrievedAt`, `publishedAt?`

Fallback is never silent: a result produced via `static-reader → browser`
reports `attemptedProviders: ["static-reader", "browser"]` with
`provider: "browser"`.

`ResearchResult`:

- `id`, `requestId`, `source`, `title?`, `url?`, `excerpt?`, `content?`,
  `publishedAt?`, `retrievedAt`, `mimeType?`, `metadata?`, `truncated`

All schemas are bounded and serializable. Result payloads are capped
(`content` per-result cap + 256 KB total tool-result ceiling following the
MCP precedent); overflows set `truncated: true` instead of failing.

## Untrusted content model

Web content is hostile input and is typed as such. Tool descriptions and the
`wrapUntrustedContent` helper frame every payload as
`External source content` with provenance — never as instructions. Prompt /
query inputs reject raw credentials via the shared `containsRawCredential`
guard (same precedent as coding prompts and memory facts).

## Web page reader (engine-neutral)

`WebPageReader` interface: `read(url, options, signal)`.

- `StaticWebReader` (primary): safe fetch → content-type check → bounded
  HTML/text extraction (title, description, main text) → structured document.
  No giant parser dependency; extraction is intentionally conservative and
  swappable behind the interface.
- `JinaReaderAdapter`: optional `r.jina.ai` backend behind the same
  boundary. Jina is an adapter, never the domain abstraction.
- Future `ReadabilityAdapter` / `BrowserReaderAdapter` slot into the same
  interface without contract changes.

Static retrieval is always tried first. Browser fallback fires only on
failure or clearly insufficient content (e.g. empty text from a JS shell),
and flows through `BrowserService` (open → snapshot → close), never
Puppeteer directly.

## Search

`SearchProvider` interface: `search(query, options, signal)`.

- `ExaSearchAdapter`: Exa `/search` over `fetch`; API key resolves only via
  injected `resolveSecret(SecretRef)` — never env passthrough, never raw
  keys in inputs, outputs, logs, or errors. Without a key the adapter
  reports `authRequired` instead of failing obscurely.
- Provider SDK/API types stay inside the adapter. No LLM reranker in PR35;
  provider ordering is preserved. Results are normalized to `SearchResult`
  (`title`, `url`, `snippet`, `domain`, `publishedAt?`, `score?`) and
  deduplicated by canonical URL.

## GitHub

Structured REST adapter over `api.github.com` (`fetch`, no `gh`
subprocess): repository read, file read (base64-decoded, byte-capped,
`ref`-pinned), issue read, pull-request read, repository search. Public
access works keyless; authenticated access uses `SecretRef` + injected
resolver. Command construction is N/A (no shell); all inputs are URL/query
validated, never interpolated into commands.

## YouTube

- `metadata` via public oEmbed (keyless).
- `transcript` via best-effort caption-track discovery, degrading cleanly
  to `unavailable` with provenance intact.
- `search` via YouTube Data API v3 with `SecretRef` key; `authRequired`
  without one (no fragile HTML scraping).

No `yt-dlp`, no auto-install, no model-controlled subprocess arguments
(PR35 ships **no** subprocess adapters at all; `child_process` is absent
from the research tree by construction, enforced by a negative test).

## RSS / Atom

Simplest channel: fetch → content-type check → bounded parse of RSS 2.0
and Atom into normalized `RssItem` (`title`, `url`, `summary`,
`publishedAt`, `author?`). Item count and per-item length are capped;
malformed feeds fail closed with a canonical error.

## Universal tool lifecycle

Five tools, all `source: "builtin"`, all `runtime: "in_process"` (pure
network/API; browser fallback stays inside the service via the PR34
boundary, so no tool needs `runtime: "browser"`):

- `builtin:research.search`, `builtin:research.open`,
  `builtin:research.github`, `builtin:research.youtube`,
  `builtin:research.rss`

Every call flows
`ToolRegistry.resolve()` → input validation → `PermissionManager.check()`
→ `ResearchToolExecutor` → `ResearchService` → adapter → `ToolResult`.
No separate research lifecycle, no direct adapter invocation from renderer
or Agent Runtime. `DesktopToolRouter` gains a `builtin:research.*` branch;
its `ToolExecutorLike` options gain an optional `signal` (backward
compatible) so cancellation reaches the network layer.

Permissions use capability `"research"` with actions
`search | open | github | youtube | rss`, `scope: "once"`. Risk baseline:
public reads `low`; authenticated reads `medium`. A read grant never
implies write/post/publish (no such actions exist in this vocabulary).

## Caching

Host-owned bounded `ResearchCache` (`key`, `provider`, URL/query hash,
`retrievedAt`, `expiresAt`, bounded payload; FIFO eviction at a fixed
entry cap). TTLs are centralized per channel (search short, feeds longer).
Authenticated resources and anything touching secrets are never cached.

## Security (mandatory)

- **SSRF guard** (`security/ssrf-guard.ts`, DNS-backed via injectable
  resolver defaulting to `node:dns/promises`): before every request and
  every redirect hop — validate scheme, resolve host, reject loopback,
  RFC1918, link-local (incl. `169.254.169.254` metadata), ULA, unspecified,
  multicast, broadcast, reserved, CGNAT, and documentation ranges; literal
  IPs are checked without DNS. Loopback is overridable only via an explicit
  test-only option (prod wiring leaves it denied).
- **Redirect policy**: manual redirect loop (`maxRedirects`), every hop
  re-resolved through scheme + SSRF validation; original URL is never
  trusted after a redirect. Residual DNS-rebinding TOCTOU is documented as
  future hardening (connection pinning), not solved here.
- **Protocol allowlist**: `http:` / `https:` only. `javascript:`,
  `vbscript:`, `data:`, `file:`, `blob:`, `ftp:`, `gopher:` rejected
  syntactically in ai-core (no network needed to say no).
- **Response limits**: compressed/decompressed byte caps, document
  character cap, per-channel result caps, 256 KB total tool-result ceiling.
- **MIME policy**: `text/html`, `text/plain`, `application/json`,
  `application/xml`, `application/rss+xml`, `application/atom+xml`
  (+ `+xml` suffix family); binaries are `unsupported`, never downloaded
  or executed.
- **Credentials**: `SecretRef` + injected resolver only; keys/tokens never
  appear in tool results, events, logs, errors, SQLite, or IPC payloads.
  Redaction is tested, not assumed.
- **Cancellation/timeouts**: every operation takes `AbortSignal`; connect /
  request / body / overall timeouts are centralized; cancellation is
  idempotent and stops HTTP, parsing, redirects, and browser fallback.
- **Concurrency**: bounded semaphore (`MAX_CONCURRENT_RESEARCH_REQUESTS`)
  around outbound adapter work.

## Provider health

Host-side `ResearchProviderStatus`
(`available | unavailable | degraded | authRequired`) per adapter, probed
without network (configuration-driven: missing key → `authRequired`).
Supports future diagnostics UI; no CLI doctor system.

## Workspace & IPC

Minimal surface following the PR34 recipe exactly:

- Typed IPC: `research:search`, `research:open` (query + read-only fetch;
  explicitly **no** `research:execute` — execution flows through the agent
  tool router). Handlers call `ResearchService` directly for user-initiated
  UI actions, mirroring the browser IPC precedent.
- Preload: `searchResearch` / `openResearch`; renderer `ResearchSurface`
  (query, result list with source/domain, open, provenance view); opening a
  result can hand off its URL to the existing `BrowserSurface`.
- Rich surfaces: search executions stamp an additive `metadata.surface`
  table descriptor via `buildSurfaceMetadata` (PR33 convention); research
  summaries can materialize as document surfaces through the existing
  lifecycle. No new rendering path.

## Agent Runtime & memory & events

- No `ResearchAgent`, no second ReAct loop. The existing agent discovers
  `builtin:research.*` through the router and decides
  search → inspect → open → synthesize.
- Research results are ephemeral: nothing auto-stores into project memory;
  retention stays an explicit later action through the memory subsystem.
- No new event taxonomy: `tool.call.*` covers the lifecycle; research
  output is tool output.

## Source tree

```text
packages/ai-core/src/
  identifiers.ts        (+ Research* ULID brands)
  research.ts           (channels, sources, provenance, results, tools,
                         capability/risk, ceilings, pure URL helpers)
  research.test.ts

apps/desktop/src/main/research/
  index.ts
  research-errors.ts
  research-policy.ts
  research-cache.ts
  research-provenance.ts
  research-service.ts
  research-tool-executor.ts
  routing/research-router.ts
  security/url-policy.ts
  security/ssrf-guard.ts
  security/redirect-policy.ts
  security/response-policy.ts
  adapters/web/web-reader.ts
  adapters/search/search-provider.ts
  adapters/github/github-research.ts
  adapters/youtube/youtube-research.ts
  adapters/rss/rss-research.ts
  __tests__/<mirror>.test.ts
```

## Tests (hermetic — no live internet in unit tests)

- ai-core: IDs, schemas, provenance, bounds, serialization, vocabulary,
  risk maps, URL guards, canonicalization, dedupe (~25).
- URL security: loopback, RFC1918, link-local, metadata, ULA, multicast,
  reserved, CGNAT, literal-IP obfuscation, DNS failures, redirect-to-private,
  redirect-to-forbidden-scheme, dangerous schemes, MIME policy, body limits
  (30+; DNS and fetch injected).
- Web reader: HTML/text/JSON, unsupported MIME, truncation, redirects,
  timeout, cancellation, malformed (local HTTP fixture server).
- Search/GitHub/YouTube/RSS: normalization, dedupe, bounds, provider
  errors, auth boundary, cancellation, malformed feeds (mock fetch /
  fixtures).
- Cache: hit/miss/expiry/invalidation/bounded eviction/authenticated
  bypass.
- Security: no credential leakage (keyed resolver + output scan), no
  `child_process` anywhere under the research tree, no unbounded
  allocation, no internal-address fetch.
- Integration/E2E (real architecture, stub network edge): agent
  search → select → open → Workspace-shaped result via `AgentRuntime` +
  `DesktopToolRouter`; static-failure → browser-fallback via stubbed
  `BrowserService` with `browser` provenance.
- IPC: validation rejection, unavailable-service failure, absence of
  `research:execute`.
- Renderer: research surface search/open flows against a stubbed
  `window.api`.

## Non-goals (explicit)

Agent-Reach dependency/fork/installer; model-driven installs; arbitrary
shell; stealth browsing; CAPTCHA/proxy/cookie subversion; profile import;
posting/publishing; unbounded crawling; LLM reranking; autonomous research
agent; second ReAct loop; cloud browser; marketplace.

## Acceptance gate

Public web search, page reading, GitHub, YouTube, RSS all work through the
universal lifecycle with provenance, bounds, cache, cancellation, timeout,
SSRF/redirect/scheme protection, secret hygiene, no shell execution,
ToolRegistry + PermissionManager mediation, PR34-boundary browser fallback,
Workspace integration — plus green `format:check`, `architecture:check`,
`typecheck`, `lint`, `test`, `build`, and the research
integration/security/E2E suites.
