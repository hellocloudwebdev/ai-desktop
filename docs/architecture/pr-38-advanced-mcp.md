# PR38 — Advanced MCP & MCP Apps Foundation

## 1. Objective

PR38 upgrades the PR25 MCP foundation from tools-only to full capability
coverage — lifecycle, capability discovery, resources, resource templates,
prompts, subscriptions, structured results, and interactive MCP Apps
through RichSurface — without creating a competing tool/runtime
architecture.

```text
MCP Server
   ↓
MCPHost (lifecycle + discovery + bounded retrieval)
   ↓
Tool / Resource / Prompt discovery
   ↓
Canonical ToolRegistry (mcp:<server>/<tool>, hash-tracked)
   ↓
Universal ToolExecutor (resolve → validate → permission → execute)
   ↓
PermissionManager (capability-aware risk)
   ↓
Agent / Chat / Workspace
```

Interactive path:

```text
MCP Tool
   ↓
Structured result + UI metadata
   ↓
MCP App bridge (pure normalization, renderable kinds only)
   ↓
RichSurface (permission-gated, sandboxed)
```

**Rules:** Agent Runtime never touches the MCP SDK; MCP SDK types never
leave `packages/mcp`; prompts/resources/descriptions are untrusted data;
annotations never replace permission checks.

---

## 2. Canonical Contracts (`@ai-desktop/ai-core`)

New module `mcp-capabilities.ts` (pure; SDK verified as
`@modelcontextprotocol/sdk` 1.30.0 — Client supports tools, resources,
templates, prompts, subscriptions, and list-changed notifications).

- Branded ULIDs: `MCPServerId`, `MCPResourceId`, `MCPPromptId`,
  `MCPSubscriptionId` (tools keep the canonical `mcp:<server>/<tool>`
  string namespace — no brand, documented).
- Transports: `stdio | sse | streamable-http | in-memory` (verified;
  websocket exists in SDK but the host doesn't wire it).
- Lifecycle: `configured → connecting → ready ⇄ degraded → disconnected
→ connecting/stopped`, `failed → connecting/stopped`, with
  `VALID_MCP_SERVER_TRANSITIONS` validation. UI never assumes a
  configured server is available.
- Capabilities: open-shape object (tools/resources/prompts/logging/
  subscriptions/list-changed flags, forward-compatible).
- Tools: `MCPToolDefinition` (canonical id regex, annotations
  readOnly/destructive/idempotent/openWorld — advisory only).
- Resources: `MCPResourceDefinition`, `MCPResourceTemplate` with
  `validateResourceTemplateUri` (scheme + segment match; rejects `..`,
  `javascript:`/`data:`/`file:`), `MCPResourceContent` (text or base64,
  256 KB cap, truncation flag).
- Prompts: `MCPPromptDefinition`, `MCPPromptResult` (`framed: true`
  marker — framing applied at the ai-core boundary, never trusted).
- Results: `MCPToolResultContent` (text/image/audio/resource/structured)
  - `MCPToolResult` with server provenance (never flattened silently).
- Bounds: 16 servers, 128 tools / 256 resources / 64 prompts per server,
  256 KB results, 64 subscriptions/project (300 s TTL), 128 KB surface
  payloads.
- Health: state/transport/timestamps/capabilities/counts — never
  secrets. `mcpRiskFor`: connect/tool-execute/app-interact → medium,
  resource-read/prompt-get/subscription-create → low.
- Framing: `UNTRUSTED_MCP_CONTENT_HEADER` + `frameMcpContent`; events:
  8 `mcp.*` names (published via the existing `extension.custom`
  boundary — no new event architecture).

---

## 3. Host (`packages/mcp`)

- `mcp-capability-discovery.ts`: `CapabilityDiscovery.discover()`
  prefers `getServerCapabilities()`, falls back to probing
  list/tools/resources/prompts, never throws.
- `in-process-mcp-host.ts`: sessions gain capabilities, resource/
  template/prompt maps, per-project subscriptions; post-connect bounded
  syncs (256/64); `resources|prompts/list_changed` resync +
  `onCapabilitiesChanged`; new methods `listResources/readResource/
listPrompts/getPrompt/subscribe/unsubscribe/getHealth`; URI gate;
  256 KB ceiling; subscription caps/TTL/disconnect cleanup;
  `secretRef` env resolution via injected `SecretStore` (stdio-only);
  stdio env restricted to a 10-entry allowlist + resolved config env
  (no full `process.env` inheritance); `streamable-http` transport
  wired (verified SDK export, http(s)-only URLs, no embedded
  credentials); `callTool` preserves `metadata.structuredContents`.
- Config: `{ secretRef }` object env values, URL validation, raw
  credential rejection preserved.
- Executor: `risk: mcpRiskFor("tool-execute")` (medium); soft 15 s /
  hard 30 s timeouts, 256 KB ceiling, additive surface stamp kept.
- `mcp-app-surface.ts`: pure `buildMcpAppDescriptor` (structured
  contents → document/table/form descriptors only; 128 KB cap;
  provenance `{source:"mcp", originId}`) + `validateMcpAppAction`
  (rejects unknown actions, forged server ids, cross-project use).
  No `eval`/`new Function`/arbitrary execution anywhere.

---

## 4. Desktop, IPC, Workspace

- `main/mcp/mcp-host.ts`: `getMcpHost()` singleton + test seam +
  `mcpSurfaceDescriptorFor` provider (SurfaceService gates + binds).
  New `desktop → mcp` edge recorded in `dependency-graph.json/.md`;
  `package.json` + vitest alias added (repo's first real use of the
  dependency — previously injected only in tests).
- IPC (`mcp:listServers/getServer/connect/disconnect/listCapabilities/
listResources/readResource/listPrompts/getPrompt/subscribe/
unsubscribe`): typed schemas, projectId required on read/prompt/
  subscribe, URI bounds at the boundary. No `mcp:execute` — connect is
  startup-configured (IPC connect fails closed by design).
- Preload: 11 typed `*Mcp*` commands, thin invoke wrappers.
- Workspace: `mcp` surface (sidebar tab + `WORKSPACE_SURFACES` entry),
  `McpServersSurface` list+detail (state badge, capabilities, counts,
  disconnect), App-owned state over the bridge, optional `mcp` prop
  (absent → "MCP unavailable" placeholder, never crash).

---

## 5. Security & Verification

- Renderer: no Node/Electron/fs/path/child_process/Prisma in MCP UI;
  typed bridge only; surfaces sandboxed via RichSurface hash-bound
  bindings + render/interact permission gates.
- Server: malformed capabilities/tools/URIs rejected; oversized
  results truncated; stale tools unregistered before execution;
  disconnect clears tools + subscriptions; reconnect rediscovers.
- Isolation: subscriptions and authorization per project; permission
  checks carry projectId; cross-project actions rejected.
- Secrets: `secretRef` only in config; raw keys rejected; errors and
  health snapshots sanitized (regression-asserted).
- Poisoning: prompts/resources/descriptions stay framed data
  (40-test security suite: injection, tool-poisoning, resource-
  poisoning, forgery, cross-project, secret leakage).
- E2E (real SDK Server + InMemoryTransport): full lifecycle incl.
  structured result → surface descriptor → action validation;
  disconnect/reconnect recovery; idempotent cancellation.
- Gates: `architecture:check`, `typecheck`, `lint`, `test`, `build`,
  `format:check` — zero new dependencies (SDK 1.30.0 already present).
