# Security Baseline — Production Posture (PR46)

Point-in-time inventory of the production security posture as of **PR45 +
PR46**. PR46 adds documentation and the `security.*` audit taxonomy only;
nothing here implies new enforcement. Each item carries one status:

- **implemented** — verified in the tree during PR46.
- **partial** — exists but with a verified gap or an unlanded sibling slice.
- **not-implemented** — acknowledged need, no code.
- **out-of-scope** — explicitly not a goal; stated so operators do not assume it.

## 1. Electron configuration — implemented

`getSecureWebPreferences` (`apps/desktop/src/main/index.ts`, verified):
`preload` set; `contextIsolation: true`; `nodeIntegration: false`;
`sandbox: true`; `webSecurity: true`; `allowRunningInsecureContent: false`.
Single `BrowserWindow`; dev loads `VITE_DEV_SERVER_URL`, production loads
local `dist/index.html`; teardown clears streams, destroys the IPC registry
(+ batcher timers), and closes the database. Preload (`apps/desktop/src/
preload/index.ts`, verified) exposes only narrow `window.api` through
`contextBridge` — no raw `ipcRenderer`, `shell`, `fs`, or `process`. CSP
meta present in `apps/desktop/index.html`. Renderer sources assert no
Node/Electron imports (per-surface test assertions, PR41+ pattern).

## 2. IPC rules — implemented

`IpcRegistry.registerCommand` (`apps/desktop/src/main/ipc/index.ts`,
verified): Zod validation of every command payload in main **before** the
handler runs; duplicate channel registration throws; responses are
`{ ok, value }` / `{ ok: false, error: { code, message } }` with no stack
traces. No `*:execute` channel exists in any domain (verified by search:
chat, surface, browser, research, documents, attachments, mcp, realtime,
workspace, terminal, git, background-tasks, schedules, account, sync).
Subscriptions bind to the sender `WebContents` and are cleaned up on
destroy; unsubscribe is idempotent. Full contract in `IPC-SECURITY.md`.

## 3. Secrets rules — implemented, with a known user-input boundary

`SecretStore` / `OSKeychainSecretStore` (`@napi-rs/keyring`) hold values;
SQLite stores only `SecretRef` / non-secret `credentialRef` (verified).
Provider configs, memory facts, schedules, sync records, and account fields
reject secret-shaped input (verified). Renderer redacts `key=value`-shaped
fragments. **Boundary (partial edge):** operator-pasted secrets inside free
chat text persist verbatim as message events (T29); no purge affordance was
verified. Full lifecycle in `SECRETS.md`.

## 4. Process / package isolation — implemented

Constitutional boundaries mechanically enforced by
`eslint-plugin-boundaries` + `scripts/validate-dependencies.mjs` against
`docs/architecture/dependency-graph.json`: Electron only in `apps/desktop`,
Prisma only in `packages/storage`, provider SDKs only in
`packages/providers`, MCP SDK only in `packages/mcp`, `agent-runtime` never
calls Docker or the MCP SDK directly (verified in AGENTS.md §2 +
CONSTITUTION.md; validator suite passes).

## 5. Permission checkpoint and tool lifecycle — implemented

Every tool follows resolve -> validate -> `PermissionManager.check` ->
execute (verified across coding, browser, research, documents, git, MCP,
skill, plugin executors). `DefaultPermissionManager`: 5-dimension
evaluation, explicit deny precedence, 4 scopes (`allow_once`,
`allow_session`, `allow_project`, `deny`), `secrets.use` != `secrets.read`
(verified). Batch coalescing, revocation, and append-only audit persistence
(PR24). Model text can never self-grant; blocked runs resume exactly.

## 6. Schedule / sync / sign-in are never grants — implemented

Structural, not advisory: scheduled runs pass the permission checkpoint and
park on `waiting_permission`; synced schedules arrive inert
(`enabled=false`); sign-in confers no capability (verified in
`packages/ai-core/src/schedules.ts` header, ADR-016/017, PR44/45 services).

## 7. Network policy — implemented for research egress

SSRF guard + `secureFetch` (`apps/desktop/src/main/research/security/`,
verified): private-range rejection, per-redirect re-validation (DNS-
rebinding protection), fail-closed DNS, hard redirect ceiling, MIME policy,
size/timeout bounds, `allowedHosts` test-only escape hatch. Research is the
audited egress path. Full policy in `NETWORK-SECURITY.md`. **Partial edge:**
no verified connection-level IP pinning (T17 residual); query-parameter
exfiltration to public URLs is not SSRF and is not blocked (T16 residual).

## 8. Persistence assumptions — implemented discipline, explicit non-goal

Events are append-only with `UNIQUE(conversationId, sequence)`; no
update/delete event APIs exist (verified). SQLite runs in WAL mode with
restart recovery (verified). **Explicit honesty (out-of-scope): no
cryptographic tamper resistance against a local filesystem attacker.**
A process/user able to write the app's files or SQLite can rewrite history
and policies undetectably (T24). Mitigations are environmental (OS user
separation, full-disk encryption), not app-provided.

## 9. Sync trust — partial (fail-closed stub verified)

Contracts enforce the closed entity allowlist, secret/path refusal both
directions, inert schedules, tombstones, and explicit conflict resolution
(verified in `packages/ai-core/src/sync.ts`, ADR-017). **Partial:** the
desktop `SyncService` has not landed — `getSyncService()` throws
`SyncService is not available` and all five `sync:*` channels run
fail-closed stubs (verified in `apps/desktop/src/main/index.ts`). No live
transport risk exists yet; transport authentication/authorization is future
work owned by the sibling layer.

## 10. Logging bounds — partial

Structured `CODE: message` errors with no secret echo; truncation markers on
every ceiling (256 KB results, prompt caps, bounded renderer lists);
permission audit stores decisions without secrets (verified). **Partial:**
no verified global scrubber on IPC error envelopes — third-party library
messages may embed paths/URLs (T03 gap); chat message content is verbatim
history by design (T29).

## 11. Supply chain — partial

Pinned toolchain (AGENTS.md §4), zero-new-dependency discipline, SDK
quarantine with mechanical boundary checks, no auto-update/marketplace
(explicit non-goals). **Partial:** no verified lockfile-integrity check,
SBOM, vulnerability scanning, or signature verification in this PR (T28).

## 12. Extension / MCP-server trust — implemented framing, out-of-scope sandbox

Manifest validation, closed capability enum, lifecycle with per-project
bindings defaulting to off, SHA-256 definition hashes with trust
invalidation, `extension.custom`-only event factory, URI/result ceilings,
stdio env allowlist, secretRef resolution (verified). **Out-of-scope:**
extension sandbox process, marketplace review, remote registry, auto-update
(explicit PR32 non-goals). Plugins and MCP servers are **untrusted**
(`EXTENSIONS.md`).

## 13. Incident response — documentation only (partial)

`INCIDENT-RESPONSE.md` gives local-first guidance (what to collect,
rotation via `SecretStore`, what is/isn't logged). **Partial:** no
in-app incident tooling, no tamper-evidence feed beyond the append-only log,
no remote wipe/revocation (explicit non-goals).
