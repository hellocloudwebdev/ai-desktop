# PR32 — Extension / Plugin Ecosystem Foundation

## Purpose

PR32 establishes the safe extension framework that later plugins consume.
An extension is a controlled capability provider, not a privileged second
application. The framework integrates with existing systems — manifest →
registry → lifecycle → capability declaration → permission → ToolRegistry →
ToolExecutor → Workspace — without creating a second runtime, registry,
executor, event store, or permission model.

## Definitions

- **Skill** = package of instructions/references/scripts (PR26).
- **MCP server** = external capability provider (PR25).
- **Extension** = ecosystem package contributing controlled application
  capabilities (PR32). May contribute tools; never owns an agent loop.
- **Agent** = autonomous reasoning/orchestration (PR29).

`Extension ≠ Skill ≠ MCP Server ≠ Agent`.

## Manifest

Canonical `ExtensionManifestSchema` (`packages/plugins/src/core/manifest.ts`):
`id` (slug `^[a-z0-9][a-z0-9-]{0,63}$`), `name`, SemVer `version`,
optional `displayName`/`description`/`publisher`, `capabilities` (min 1,
normalized), `contributes.tools` (max 16, names `^[a-z0-9-_]{1,64}$`,
descriptions ≤500 chars, safe relative `entry` files that must exist),
optional `minimumHostVersion`, optional `metadata`. Manifest JSON capped at
64KB. A `superRefine` secret-scan rejects metadata keys/values matching
credential patterns (`apikey|password|secret|accesstoken|privatekey`).
The manifest declares what the extension _wants_; it never contains secrets.

## Lifecycle

`installed → enabled → active`, plus `disabled` and terminal `uninstalled`
(`packages/plugins/src/core/lifecycle.ts`). Transitions validated by
`assertTransition`; illegal transitions throw `ValidationError`.
Enable/disable are idempotent. `ExtensionManager` (`core/extension-manager.ts`)
orchestrates install/enable/activate/deactivate/uninstall over repository
interfaces plus the registries; disabling unregisters tools immediately;
uninstall removes bindings and metadata while historical events stay intact.

## Registry

`ExtensionRegistry` (`core/extension-registry.ts`) owns install/lifecycle/
trust records only — no tool logic. Duplicate registration rejected.
`PluginToolRegistry` (`tools/extension-tool-contribution.ts`) owns
`plugin:<extensionId>/<toolName>` definitions with MCP-style definition
hashes and `resolveForProject` per-project gating.

## Capability model

Closed enum (`core/capabilities.ts`): `tool.register`, `workspace.view`,
`conversation.read`, `conversation.write`, `project.read`,
`filesystem.read`, `filesystem.write`, `execution.run`, `network.request`,
`secrets.use`, `memory.read`. Normalized deterministically
(dedupe + sort). A manifest declaration is a _request_, never a grant:
authorization comes from `PermissionManager`, enforcement from the executor.

## Trust vs permission

Trust (`core/extension-trust.ts`) records whether the host operator accepts
a specific extension definition (SHA-256 over canonical
`{id, version, sorted capabilities, contributes}`). Install auto-assigns
`untrusted`; a definition/hash change invalidates prior trust via
`markTrustInvalidated` (trusted → untrusted, blocked stays blocked).
Trust never grants runtime permission: every tool call still passes
`PermissionManager.check({capability: "plugin", action: "call", ...})`.

## Tool contributions

First real capability: extensions contribute `plugin:` tools with
`ToolSource = "plugin"` (already in ai-core; `ToolRuntime` stays
independent, `in_process` for host handlers). Registration flows through
the plugins-owned `PluginToolRegistry` on enable/activate; disable/
uninstall unregisters. Execution flows through the plugins-owned
`PluginToolExecutor`: resolve → validate input → extension/project gate →
`PermissionManager.check` → host handler (30s timeout, `AbortSignal`).
Validation failure → no permission call → no backend. Disabled or
project-disabled → `isError` `ToolResult` with `pluginStatus` metadata,
zero permission/backend calls. Permission denial → no backend.
The desktop `DesktopToolRouter` routes the `plugin:` prefix to this
executor, so agent tasks consume extension tools naturally.

## ExtensionEvent

`buildExtensionCustomEvent` / `validateExtensionEvent`
(`core/extension-events.ts`) construct only `type: "extension.custom"`,
`category: "extension"` events validated against ai-core's
`ExtensionCustomEventSchema` (payload ≤64KB). Type/category are hardcoded,
so forging core/capability events through this factory is impossible
(proven by test). No new event types, no second event store.

## Persistence

`ExtensionRecord` (`extension_records`) + `ExtensionProjectBindingRecord`
(`extension_project_bindings`, composite `@@id`, project index) in
`prisma/schema.prisma` with migration
`20260913091003_plugin_ecosystem`. Prisma stays inside `packages/storage`;
repositories (`src/extensions/`) mirror the skill-repository pattern.
`ExtensionService.restore()` rebuilds in-memory registry/active flags/tool
definitions from the same `StorageDatabase` after restart (proven by test).

## Project isolation

Installation is global; enablement is per project
(`ExtensionProjectBindingRepository`). `isEnabledForProject` defaults to
false with no binding. Proven: Project A enabled resolves, Project B
without binding is blocked with `plugin-disabled` metadata and no backend.

## IPC

Eight narrow channels (`extension:list/get/install/uninstall/enable/
disable/project-enable/project-disable`), Zod-validated in main. No
`extension:execute` — tools execute via the agent tool router. Preload
exposes typed `listExtensions/getExtension/installExtension/
uninstallExtension/enableExtension/disableExtension/
setExtensionProjectEnabled` only; no native objects.

## Workspace UI

Additive `extensions` surface in the PR31 workspace: sidebar tab with
active-count badge, `ExtensionsSurface` (list + details: lifecycle/trust
badges, capabilities, manifest hash, enabled projects, enable/disable,
per-project toggle), App-owned state over the preload bridge. Stale
persisted surfaces fall back to `chat` (same storage key, `version: 1`).

## Installation / uninstallation / update

Install: validate manifest → copy files → persist metadata → `installed`
(zero code execution, no npm, no downloads). Uninstall: disable →
unregister tools → delete bindings → delete metadata → remove files;
events untouched. Update: version/hash change → trust invalidation →
re-approval required; grants never silently carry over.

## Security

Bounded manifest (64KB), tools (≤16), descriptions, event payloads (64KB);
`isSafeRelativePath` everywhere; secret-scan on install; host-owned
handlers (extensions never execute their own code in-process);
`capability: "plugin"` permission mediation with existing approval scopes;
per-package boundary test (no Electron/Prisma/SDKs/process/env in
`@ai-desktop/plugins`); renderer boundary test extended with the new
surface + `@ai-desktop/plugins` marker. Extension failure returns a
structured `ToolResult`, never crashes the host.

## Non-goals

Marketplace, remote registry, auto-update, sandbox process, browser
automation, MCP Apps, GitHub App, cloud sync, accounts, billing, native
modules, arbitrary Electron/fs/child-process access, install scripts.

## Future roadmap

Signed packages, richer contribution types (views/commands/connectors),
remote discovery, background update service — each a separate milestone
on top of this foundation.
