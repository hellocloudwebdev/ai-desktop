# Extensions & MCP Servers as Untrusted (PR46)

Plugins (extensions) and MCP servers run third-party code and serve
third-party content. They are **untrusted**: every affordance below is a
containment rule, not a trust signal.

## 1. Extension manifest and trust

- `ExtensionManifestSchema` (verified per PR32 design + phase-0): slug id,
  SemVer, closed capability enum, `contributes.tools <= 16`, 64 KB cap,
  secret scan. Malformed or secret-bearing manifests fail validation.
- Lifecycle `installed -> enabled -> active` (+ `disabled`/`uninstalled`);
  per-project enablement bindings default to **false**; restart recovery
  via `ExtensionService.restore()`.
- Trust (`trust != permission`): deterministic SHA-256 definition hashes;
  any definition change invalidates trust and requires re-approval.
  `tools/list_changed` resync removes stale tools without restart.
- Audit slots: `security.plugin.rejected` (manifest/lifecycle gates),
  `security.integrity.failure` (hash mismatches).

## 2. Extension lifecycle and capability boundaries

- Tool contributions use `plugin:<id>/<tool>` ids (`ToolSource = "plugin"`)
  through `PluginToolExecutor`: resolve -> validate -> project gate ->
  permission -> host handler. No direct fs/network/process access.
- Extensions emit **only** `extension.custom` events — core/capability
  event forgery is structurally impossible through the extension API (T25).
- Surface contributions: renderable kinds only (document/table/form), no
  raw HTML, dangerous URLs degrade to text, forged/cross-project actions
  rejected via registered-binding hash match (PR33).
- No `extension:execute` IPC channel (verified). Host handlers, not guest
  code, perform privileged work.

## 3. MCP servers as untrusted

- Config validation rejects raw credentials (`apiKey`, `password`,
  `secret`, `accessToken`, `authorization`); secret env arrives only as
  `{ secretRef }` objects resolved at connect via the injected
  `SecretStore` (verified in `mcp-server-config.ts`,
  `in-process-mcp-host.ts`).
- Stdio children inherit **only** the allowlisted env + resolved config
  env — never wholesale `process.env` (verified).
- Tool descriptions, resources, and prompts are untrusted input: URI gates
  (2000-char cap), 256 KB ceilings with truncation markers, per-server and
  per-project caps, 300 s subscription TTL, structured-result preservation,
  and tool-list invariant tests (verified).
- Audit slot: `security.mcp.rejected`.

## 4. Explicit non-goals (out-of-scope)

Plugin marketplace, remote registry, auto-update, extension sandbox
process, full MCP Apps runtime, GitHub App integration, cloud plugin sync,
billing/entitlements (per phase-0). There is no code review, signing, or
sandboxing of extension code: **a well-formed malicious extension passes
validation — operator judgment is the control.**

## 5. Operator guidance

- Enable extensions per project, least-capability first; disable bindings
  you do not use (defaults are already off).
- Treat re-approval prompts after definition changes as security events,
  not annoyances: inspect what changed before re-approving.
- Never paste secrets into extension configuration fields; use SecretStore
  refs where the host supports them.
