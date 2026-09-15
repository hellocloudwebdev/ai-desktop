# PR35 — Web Research & Internet Connectivity Foundation

## 1. Objective

PR35 establishes the **Web Research & Internet Connectivity Foundation** for AI Desktop. It provides the Agent Runtime with safe, structured, high-provenance internet research capabilities without turning Browser Automation into the general-purpose research abstraction.

```text
Agent Runtime
    ↓
ToolRegistry (canonical tool definitions: builtin:research.*)
    ↓
PermissionManager (5-dimensional capability: research)
    ↓
ResearchToolExecutor (resolve → validate → permission → execute)
    ↓
ResearchService (caching, deduplication, provenance, artifact coordination)
    ↓
ResearchRouter
    ├── WebPageReader (safe HTTP fetch, SSRF guard, redirect controls, HTML/text extraction)
    │     ↳ fallback: BrowserService (PR34 browser fallback when static reader insufficient)
    ├── SearchProvider (pluggable search backends, structured SearchResults)
    ├── GitHubResearchAdapter (structured GitHub repo, file, issue, and code search)
    ├── YouTubeResearchAdapter (structured metadata, transcript extraction)
    └── RSSResearchAdapter (RSS 2.0 / Atom feed parser with bounded items)
```

Browser automation remains an independent execution primitive (`builtin:browser.*`). When a web research task requires dynamic JavaScript execution or interactive session state, the `ResearchService` can fall back through the controlled `BrowserService` boundary to capture page content.

---

## 2. Inviolable Architectural & Security Rules

1. **Third-Party Policy**: We adopt multi-channel routing, provider fallbacks, and provenance ideas conceptually from reference designs like Agent-Reach, but **do not** install Agent-Reach or import its Python codebase.
2. **Host-Managed Dependencies**: The model is never permitted to install packages or execute package managers (`npm`, `pip`, `brew`, `curl | sh`). Adapters must be host-installed and managed.
3. **No Shell Injections**: Adapters utilizing host CLIs (e.g. `gh`, `yt-dlp`) never invoke a shell with raw model strings. Executables are spawned strictly with explicit argument arrays, hard timeouts, bounded output buffers, and cancellation support.
4. **Mandatory SSRF Guard**: Every outbound request and subsequent redirect verifies the destination against private/internal address ranges:
   - Loopback (`127.0.0.0/8`, `::1`)
   - RFC 1918 IPv4 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
   - Unique Local IPv6 (`fc00::/7`)
   - Link-local addresses (`169.254.0.0/16`, `fe80::/10`)
   - Cloud metadata IP (`169.254.169.254`) and carrier-grade NAT (`100.64.0.0/10`)
   - Disallowed protocols (`javascript:`, `vbscript:`, `data:`, `file:`, `blob:`, `ftp:`, `gopher:`)
   - Re-checks every redirect hop after DNS resolution to prevent DNS rebinding attacks.
5. **Universal Tool Lifecycle**: Every research tool execution goes through `ToolRegistry.resolve()`, Zod schema validation, `PermissionManager.check()`, and `ResearchToolExecutor`.
6. **Provenance Required**: Every result explicitly records source URL, channel, provider, retrieved timestamp, published timestamp (if available), attempted providers, and successful provider.
7. **Secret Quarantine**: Zero raw API keys, bearer tokens, or session cookies appear in `ToolResult`, SQLite events, logs, or renderer IPC envelopes. Credentials use `SecretRef` and `SecretStore`.
8. **Bounded Outputs**: Response byte sizes, decompressed payloads, document characters, search result counts, and cache storage limits are strictly bounded to prevent memory exhaustion and compression bombs.

---

## 3. Canonical Domain Model (`@ai-desktop/ai-core`)

### 3.1 Branded Identifiers

- `ResearchRequestId`: Unique request identifier.
- `ResearchSourceId`: Unique source item identifier.
- `ResearchResultId`: Unique result identifier.
- `ResearchDocumentId`: Unique document identifier.

### 3.2 Channels

Initial closed vocabulary:

- `web`: Direct webpage fetching, extraction, and structured reading.
- `search`: Web search queries across index providers.
- `github`: Structured GitHub repository, file, issue, and code search.
- `youtube`: Video metadata and transcript extraction.
- `rss`: RSS 2.0 and Atom syndication feed parsing.

### 3.3 Provenance & Sources

```ts
interface ResearchSource {
  id: ResearchSourceId;
  channel: ResearchChannel;
  provider: string;
  url?: string;
  title?: string;
  retrievedAt: Timestamp;
  publishedAt?: Timestamp;
  contentType?: string;
  provenance: ResearchProvenance;
}

interface ResearchProvenance {
  provider: string;
  channel: ResearchChannel;
  sourceUrl?: string;
  retrievedAt: Timestamp;
  attemptedProviders: string[];
  successfulProvider: string;
  cached?: boolean;
}
```

### 3.4 Research Result

```ts
interface ResearchResult {
  id: ResearchResultId;
  requestId: ResearchRequestId;
  source: ResearchSource;
  title?: string;
  url?: string;
  excerpt?: string;
  content?: string;
  publishedAt?: Timestamp;
  retrievedAt: Timestamp;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  truncated: boolean;
}
```

---

## 4. Canonical Tool Contracts

Tools are registered in `ToolRegistry` with:

- `ToolSource = "builtin"`
- `ToolRuntime = "in_process"` (delegating to host execution adapters or browser service when required)

Canonical tool IDs:

1. `builtin:research.search`: Query the web with structured results and domain filtering.
2. `builtin:research.open`: Fetch and extract text and metadata from a URL with SSRF protection and browser fallback.
3. `builtin:research.github`: Structured inspection of public GitHub repositories, files, issues, or searches.
4. `builtin:research.youtube`: Retrieve video metadata, channel details, and transcripts.
5. `builtin:research.rss`: Fetch and parse RSS and Atom feeds with bounded item lists.

---

## 5. Security & Isolation

### 5.1 URL Security Policy & SSRF Guard

Outbound HTTP fetching strictly uses `SSRFGuard`:

- Validates URL syntax and scheme (only `http:` and `https:` allowed).
- Resolves DNS hostname before connection.
- Rejects any resolved IP belonging to loopback, private RFC 1918, private IPv6, link-local, or cloud metadata ranges.
- Enforces DNS rebinding checks on each redirect hop with a maximum of 5 redirects.

### 5.2 Content & Response Limits

- Maximum response size: 5 MB (compressed) / 10 MB (decompressed).
- Maximum document characters returned to model: 50,000 characters (truncated with flag).
- Maximum search results returned: 20 items.
- Maximum RSS items returned: 50 items.
- Allowed MIME types: `text/html`, `text/plain`, `application/json`, `application/xml`, `application/rss+xml`, `application/atom+xml`.
- Binary executable formats are rejected immediately.

### 5.3 Permissions

Canonical capability: `research`.
Action mapping:

- `search`: public search query (risk: `low`).
- `open`: public webpage reading (risk: `low`).
- `github`: public repository inspection (risk: `low`).
- `youtube`: public video metadata/transcript (risk: `low`).
- `rss`: public feed reading (risk: `low`).
- Any authenticated action elevates risk to `medium`.

---

## 6. Caching & Provider Health

- **ResearchCache**: In-memory LRU cache with TTL per channel (e.g. RSS: 30m, Web: 15m, Search: 5m, GitHub: 5m, YouTube: 60m). Keys are SHA-256 hashes of normalized request parameters.
- **Provider Health**: Tracks provider statuses (`available`, `unavailable`, `degraded`, `authRequired`) to facilitate intelligent fallback routing.

---

## 7. Browser Fallback

When `research.open` encounters a page that yields empty content due to heavy client-side JavaScript rendering, or when static reading fails, the `ResearchService` can fall back to the PR34 `BrowserService` to load the page and capture an accessibility or text snapshot. The fallback transparently preserves provenance (`attemptedProviders: ["static-reader", "browser-fallback"]`, `successfulProvider: "browser-fallback"`).

---

## 8. Workspace & IPC Integration

- **IPC Channels**:
  - `research:search`
  - `research:open`
  - `research:status`
- **Preload Bridge**: Exposed on `window.api.commands` (`searchWeb`, `openWebResearch`, `getResearchStatus`).
- **Workspace UI**: `ResearchSurface` integrated into PR33 Workspace sidebar and tabs, allowing users and agents to browse search results, view excerpts, inspect provenance, and hand off URLs to the Browser surface.
