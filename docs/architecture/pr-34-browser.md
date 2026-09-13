# PR34 — Browser Automation Foundation

## Objective

PR34 implements the Browser Automation Foundation for AI Desktop, providing a production-grade, engine-neutral browser automation subsystem. It enables the existing Agent Runtime to navigate web pages, inspect accessibility-oriented page snapshots, interact via stable element references, execute form inputs, and capture screenshots while preserving all repository architectural and security invariants.

```text
Agent Runtime
    ↓
ToolRegistry (canonical tool definitions: builtin:browser.*)
    ↓
PermissionManager (5-dimensional capability: browser)
    ↓
BrowserToolExecutor (resolve → validate → permission → execute)
    ↓
BrowserService (project-level session management & artifact handling)
    ↓
DefaultBrowserManager (engine-neutral session, context, page & action queue management)
    ↓
PuppeteerAdapter (encapsulated puppeteer-core driver)
    ↓
Chrome / Chromium / Edge
```

---

## Terminology & Domain Model

- **BrowserSession**: Logical browser session bound to a specific `projectId`, with lifecycle statuses (`starting`, `ready`, `closing`, `closed`, `failed`) and mode (`isolated` or `attached`).
- **BrowserContext**: Isolated storage context (`ephemeral` or `persistent`) preventing cookie and storage leakage between runs.
- **BrowserPage**: Persistent tab/page within a context identified by a canonical `BrowserPageId`. Pages remain warm and addressable across tool calls.
- **BrowserSnapshot**: Bounded, compact structured accessibility representation of interactive page elements (`roles`, accessible `names`, `values`, `states`) with stable element references. Never returns raw DOM or unrestricted HTML.
- **BrowserElementRef**: Stable, page-scoped reference identifier (e.g., `ref/e1`, `ref/e2`) mapped internally by `BrowserRefRegistry` to DOM selectors. Stale references from navigation or closed pages fail closed.

---

## Canonical Tool Contracts

All browser tools are registered under the established architectural conventions:

- `ToolSource = "builtin"`
- `ToolRuntime = "browser"`

Canonical tool IDs:

1. `builtin:browser.open`: Open a new browser page at a validated URL.
2. `builtin:browser.navigate`: Navigate an existing page to a validated URL.
3. `builtin:browser.pages`: List active pages within the caller's project session.
4. `builtin:browser.snapshot`: Extract compact accessibility snapshot with stable element references.
5. `builtin:browser.click`: Click an element via its stable reference.
6. `builtin:browser.fill`: Input text into a form element (passwords and tokens automatically redacted from logs).
7. `builtin:browser.select`: Select options in dropdown elements.
8. `builtin:browser.press`: Dispatch keyboard key event (e.g., `Enter`, `Tab`).
9. `builtin:browser.wait`: Wait for navigation, selector appearance, or bounded timeout.
10. `builtin:browser.screenshot`: Capture PNG screenshot, stored as a host-managed temporary artifact reference.
11. `builtin:browser.close`: Close an active page.

---

## Universal ToolExecutor Lifecycle

Every browser tool execution strictly follows the repository's universal lifecycle:

1. **Resolve**: Lookup tool definition from `ToolRegistry` (validates that tool is registered).
2. **Validate**: Input arguments validated against Zod schema before permission checks. Invalid input immediately throws `ValidationError`.
3. **Permission**: Evaluated via `PermissionManager.check`:
   - `capability`: `"browser"`
   - `action`: target action (`open`, `navigate`, `click`, `fill`, etc.)
   - `resource`: `toolName + "::" + target`
   - `scope`: `"once"`
   - `risk`: `browserRiskFor(action)` (elevated to `"high"` for sensitive password/token fills)
   - `relatedToolCallIds`: `[toolCallId]`
   - Permission denial immediately returns `isError: true` with `permissionStatus`.
4. **Execute**: Dispatches to `BrowserService` → `BrowserManager` → `PuppeteerAdapter`.
5. **Result**: Wrapped in canonical `ToolResult` with timing, status, and error translation.

---

## Security & Isolation

### 1. Navigation Security

- Top-level dangerous schemes are strictly blocked: `javascript:`, `vbscript:`, `data:`, `file:`, `blob:`.
- `BrowserNavigationPolicy` enforces safe schemes (`http:`, `https:`, `about:blank`) and optional host allowlists.

### 2. No Arbitrary Code Execution

- No `browser.evaluate` or `page.evaluate` tool exists or is exposed to models.
- Browser automation is strictly limited to structured actions on accessible elements.

### 3. Sensitive Data & Credential Protection

- Form fields matching `SENSITIVE_FIELD_PATTERN` (`password`, `token`, `secret`, `apiKey`, `credit_card`) have values redacted as `[REDACTED]`.
- Sensitive field fills are evaluated at `risk: "high"` by `PermissionManager`.
- Screenshots return host-managed artifact references (`artifactRef`) rather than giant base64 payloads embedded in tool results.

### 4. Multi-Tenant Project Isolation

- Each `BrowserSession` is strictly partitioned by `projectId`.
- A task operating on Project A cannot list, navigate, snapshot, click, or close pages belonging to Project B.

### 5. Engine Quarantine

- `puppeteer-core` is isolated entirely inside `apps/desktop/src/main/browser/puppeteer/`.
- No Puppeteer types or classes escape into `@ai-desktop/ai-core`, `@ai-desktop/agent-runtime`, or renderer surfaces.

---

## Concurrency & Resource Boundaries

- **Per-Page Action Serialization**: Sequential queue ensures operations on the same page do not interleave unpredictably.
- **Concurrent Page Execution**: Operations across distinct pages execute concurrently without blocking.
- **Resource Limits**:
  - `MAX_SESSIONS`: 10 active sessions.
  - `MAX_PAGES_PER_SESSION`: 20 open pages per session.
  - `MAX_SNAPSHOT_BYTES`: 64 KB ceiling on element snapshots.
  - `MAX_SNAPSHOT_ELEMENTS`: 200 elements per snapshot.
  - `MAX_ACTION_DURATION_MS`: 60,000 ms wall-clock action timeout.

---

## Persistence Decision

In accordance with PR34 requirements, live browser state (`Puppeteer.Browser`, `Page`, `ElementHandle`, `CDP session`, `AbortController`) is strictly non-persistent and in-memory. Speculative SQLite persistence tables are avoided. On application restart, active browser processes terminate cleanly and sessions/pages are re-initialized on demand.

---

## Workspace & IPC Integration

- **IPC Channels**:
  - `browser:session-create`, `browser:session-get`, `browser:session-close`
  - `browser:page-open`, `browser:page-list`, `browser:page-get`, `browser:page-close`
  - `browser:screenshot`
  - Explicitly **no** `browser:execute` channel.
- **Preload Bridge**: `window.api.commands` exposes typed wrappers; no raw `ipcRenderer` or Puppeteer instances.
- **Workspace Surface**: `BrowserSurface` provides tabs, URL navigation, page status, screenshot artifact inspection, and accessible toolbar controls matching the slate-900 / indigo theme.

---

## Non-Goals (Explicit Exclusions)

The following capabilities are explicitly excluded from PR34:

- Arbitrary `page.evaluate()` or script execution.
- Browser extensions or plugins marketplace.
- CAPTCHA solving, stealth/anti-bot bypass, proxy rotation.
- Automatic cookie or Chrome profile importing.
- Arbitrary file downloads or uploads to host filesystem.
- Multi-user remote browser cloud streaming.
