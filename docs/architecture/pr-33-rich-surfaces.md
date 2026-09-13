# PR33 — Rich Tool / MCP App Surface Foundation

## Terminology

- **Surface**: a user-visible UI representation of a tool result.
- **App**: a tool-provided interactive surface (MCP-App-like, constrained).
- **AppDescriptor / RichSurfaceDescriptor**: the validated declaration
  (`id`, `version`, `kind`, `title?`, `dataSchema?`, `interactionSchema?`).
- **SurfaceInstance**: a concrete rendered instance bound to one
  `toolCallId` + provenance; identity is a ULID `SurfaceInstanceId`, never
  the `ToolCallId` itself.

## Descriptor

`packages/ai-core/src/rich-surface.ts`: five recognized kinds
(`document`, `table`, `form`, `chart`, `application`); only
`RENDERABLE_KINDS = [document, table, form]` render in PR33. Zod validation
covers id/version(SemVer)/kind/title/schema/data/interaction; rejects
oversized payloads, unknown kinds, malformed schemas, raw credentials
(reuses the memory credential pattern), path traversal, and dangerous URLs
(`javascript:`, `vbscript:`, `data:`, `file:`, `blob:`).

## Registry

`SurfaceRegistry` (host-owned, in-memory): register/resolve/resolveById/
listByProject/listByToolCall/setStatus/dispose/unregister/clear. Strict
linear lifecycle declared → validated → mounted → active → disposed
(disposed terminal); per-toolCallId cap (`MAX_SURFACES_PER_TASK = 20`);
SHA-256 definition hashes (MCP convention).

## Lifecycle

Invalid transitions fail (return false); disposal is idempotent. The
SurfaceService drives validated → mounted → active on creation.

## Permissions

Existing 5-dimension model, no changes: `surface.render` (low) gates
creation, `surface.interact` (medium) gates actions, both bound to the
originating `toolCallId`. Manifest declarations remain requests, never
grants. Denial returns null (creation) or `isError` (actions) — never throws
into the runtime.

## Interactions

Structured `SurfaceAction`s (`submit`, `select`, `refresh`, `open`,
`navigate`, `copy`) with Zod `inputSchema`s. Renderer emits
`(actionId, input)`; main validates input, checks permission, and routes via
the injected `SurfaceToolInvoker` (the universal ToolExecutor path). No
`AppExecutor`, no direct plugin calls from the renderer.

## Resources

`isSafeSurfaceUrl` (http/https + relative, never dangerous schemes) and
`isSafeSurfacePath` (no traversal, no NUL) guard references. The host
resolves resources; sensitive access re-checks permission. Surfaces are
never a privilege escalation path.

## MCP integration

`McpToolExecutor` accepts an optional `McpSurfaceProvider` stamping
`metadata.surface` additively on success paths. SDK stays quarantined in
`packages/mcp`. The stamp alone creates nothing — the service requires a
registered binding hash match.

## Plugin integration

Manifest `contributes.surfaces` (max 8, renderable kinds only).
`PluginToolExecutor` accepts an optional `surfaceProvider` with the same
additive stamp. Creation additionally requires the extension to be active
and project-enabled via the host gate. Disable/invalidate flows through the
existing PR32 lifecycle.

## Workspace integration

`RichSurfaceHost` (kind switch, per-kind error boundary, title +
provenance line, dispose button) renders the store-selected instance;
document/table/form components render validated data only
(no `dangerouslySetInnerHTML`, unsafe links degrade to text). Inspector
gains a Surfaces section; selection is store-local (`selectedSurfaceId`).

## IPC

`surface:get` (unknown → null, renderer polls), `surface:action`
(structured input, Zod-validated), `surface:dispose` (idempotent). No
`surface:execute` — by design, matching the `extension:execute` ban.
Preload exposes only the three typed methods.

## Security

Level 1 (structured rendering) + Level 2 (controlled interactions)
implemented. Level 3 (isolated app runtime) explicitly future work.
Bounded everywhere: 16KB descriptors, 256KB data, 500 rows, 50 columns,
50 fields, 20 actions, 20 instances per task. Cancellation of the
originating tool/task should dispose associated instances at the call
site (runtime-owned); disposal itself is idempotent with no dangling
server state (registry is plain metadata).

## Persistence

Only durable metadata persists if a caller stores it (instance descriptors
are serializable); no React/DOM state persisted. Tool/event history remains
authoritative; no second event store; no new core events (existing
`tool.call.*` + `extension.custom` suffice).

## Cancellation

`invokeAction` accepts `AbortSignal` passthrough to the router. Disposal is
idempotent and safe to call after cancellation.

## Future isolated runtime

`kind: "application"` is recognized by the schema but render-disabled by
default policy — the forward-compatible path without the security hole.

## Non-goals

Marketplace, remote apps, arbitrary HTML/JS, Electron/Node exposure,
browser automation, local-filesystem iframe access, GitHub integration,
custom browser engine, collaboration, cloud sync, mobile, plugin
marketplace.
