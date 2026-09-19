# Threat Model — ai-desktop (PR46)

Production security and hardening threat inventory for the `ai-desktop`
monorepo as of **PR45 + PR46**. PR46 is a **threat-model + documentation +
event-taxonomy** layer only: it adds no enforcement code, no producers, and
no consumers. A sibling layer defines producers/consumers of the
`security.*` audit events; the `SecurityEventSchema` in
`packages/ai-core/src/events.ts` is types-only.

## 0. Method and honesty notes

- **Verify, don't assume.** Every "Existing mitigation" below was checked
  against the actual tree in this PR: `apps/desktop/src/main/index.ts`
  (`getSecureWebPreferences`, verified `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`,
  `allowRunningInsecureContent: false`), `apps/desktop/src/preload/index.ts`
  (contextBridge-only narrow `window.api`), `apps/desktop/src/main/ipc/`
  (`IpcRegistry.registerCommand`: Zod validation before handler, channel
  collision throws, `{ ok, error: { code, message } }` envelopes),
  `packages/storage/src/secrets/` (`SecretStore`, `OSKeychainSecretStore`,
  branded `SecretRef`), `packages/permissions/src/` (deny precedence,
  `secrets.use` != `secrets.read`), `apps/desktop/src/main/agent/filesystem/
path-policy.ts` (realpath containment, symlink-escape rejection),
  `apps/desktop/src/main/research/security/` (SSRF guard + secure fetch),
  `packages/mcp/src/` (stdio env allowlist, 256 KB ceilings, secretRef
  resolution), `apps/desktop/src/main/browser/` (dangerous-scheme rejection,
  sensitive-field redaction), `packages/skills/src/` (pre-execution SHA-256
  checksum), `packages/execution/src/` (non-root Docker, env allowlist,
  256 KB ceilings), `packages/memory/src/` (credential rejection),
  `packages/ai-core/src/schedules.ts` (caps, schedule-is-never-a-grant).
- Items not directly re-inspected cite the PR design doc
  (`docs/architecture/pr-NN-*.md`) and its test suite; they are marked
  `(per PR design doc)`.
- **No invented guarantees.** Residual risks are stated plainly, including
  the explicit non-goal: **no cryptographic tamper resistance against a
  local filesystem attacker** (see T24 and `SECURITY-BASELINE.md`).
- **No certification claims.** This model asserts no compliance, audit, or
  certification status of any kind.

## Attacker profiles

| ID  | Attacker                         | Capability                                                                                           |
| :-- | :------------------------------- | :--------------------------------------------------------------------------------------------------- |
| A1  | Untrusted remote content         | Controls web pages, feeds, repos, videos, documents, MCP prompts/resources, sync-remote records      |
| A2  | Malicious extension / MCP server | Ships manifest/tools, serves poisoned tool descriptions, resources, prompts; observes its own inputs |
| A3  | Network adversary                | Controls redirects, DNS answers, serves malicious payloads to research fetch                         |
| A4  | Local filesystem attacker        | Another process/user with read/write access to the app's files and SQLite                            |
| A5  | Compromised dependency           | Malicious or vulnerable code inside a pinned npm package                                             |
| A6  | Inattentive operator             | Pastes secrets into chat, approves prompts without reading, misconfigures policy                     |

Out of scope: remote exploitation of the OS, Electron/Chromium zero-days,
physical device theft, server-side infrastructure (there is none — the app
is local-first; PR45 sync transport is a structural port with a fail-closed
desktop stub: `getSyncService()` throws `SyncService is not available`).

## Trust boundaries

1. **Renderer <-> main** via preload/IPC (`window.api` only).
2. **Main <-> OS** via keychain (`SecretStore`), filesystem (path policy),
   network (SSRF guard), processes (execution providers).
3. **Host <-> untrusted data** (web/MCP/documents/sync-remote/memory input).
4. **Host <-> extensions/MCP servers** (manifest trust, capability gates,
   per-project enablement).
5. **App <-> local filesystem attacker** — explicitly **not defended**
   cryptographically (T24).

---

## T01 — Renderer compromise escapes to main process

- **Asset:** Main-process privileges (fs, network, keychain refs, shell).
- **Attacker:** A1 (via XSS in rendered content) / A6.
- **Trust boundary:** 1 (renderer <-> main).
- **Attack vector:** Script execution in renderer calls privileged APIs.
- **Existing mitigation:** `getSecureWebPreferences` (verified):
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, `allowRunningInsecureContent: false`; preload exposes
  only narrow `window.api` via `contextBridge` (verified: no raw
  `ipcRenderer`, `shell`, `fs`, `process`); CSP meta in
  `apps/desktop/index.html`; rich surfaces render no raw HTML (PR33).
- **PR46 mitigation:** Documents the boundary (`IPC-SECURITY.md`,
  `SECURITY-BASELINE.md`); `security.ipc.rejected` audit type for rejected
  crossings (types only, no producer in this PR).
- **Residual risk:** A Chromium sandbox escape or preload bug would still
  expose main; renderer XSS is contained, not eliminated.
- **Security tests:** `apps/desktop/src/__tests__/shell.test.ts` (PR12).

## T02 — Malicious renderer IPC payload reaches privileged handler

- **Asset:** Any main-side service (chat, files, git, schedules, accounts).
- **Attacker:** A1 (renderer XSS) / A6.
- **Trust boundary:** 1.
- **Attack vector:** Crafted `window.api.*` arguments (traversal paths,
  oversized blobs, wrong types).
- **Existing mitigation:** `IpcRegistry.registerCommand` Zod-validates every
  payload in main before the handler runs (verified); per-domain schemas
  re-check bounds (e.g. base64 ingest bounds, path policy at service layer);
  handlers fail closed (`CODE: message`, no secret echo).
- **PR46 mitigation:** Channel contract requirements (`IPC-SECURITY.md`);
  `security.ipc.rejected` taxonomy slot.
- **Residual risk:** A missing/incomplete per-channel schema would pass
  through; defense depends on schema authors covering every channel.
- **Security tests:** `apps/desktop/src/__tests__/ipc.test.ts` (PR13);
  per-domain IPC tests (browser/research/documents/IPC suites).

## T03 — IPC error messages leak paths, secrets, or internals

- **Asset:** Confidentiality of secrets, paths, topology.
- **Attacker:** A1 (reads error text in renderer).
- **Trust boundary:** 1.
- **Attack vector:** Handler throws `Error` containing a path, env value, or
  key; envelope forwards `err.message`.
- **Existing mitigation:** Envelopes carry only `{ code, message }` (verified,
  no stack); services use fail-closed `CODE: message` errors with no secret
  echo (PR45 pattern); path-free error envelopes in workspace services
  (per PR41 design doc).
- **PR46 mitigation:** Error-hygiene rule (`IPC-SECURITY.md`); redaction
  policy (`SECRETS.md`).
- **Residual risk:** `err.message` from third-party libraries (Puppeteer,
  git CLI, SDKs) may embed paths/URLs; no global scrubber on the envelope
  path was verified.
- **Security tests:** Per-domain IPC tests assert envelope shape; no
  dedicated secret-in-error sweep was verified — gap noted.

## T04 — IPC channel collision / handler hijack

- **Asset:** Integrity of IPC dispatch.
- **Attacker:** A2 (extension code running in main) / developer error.
- **Trust boundary:** 1 / host<->extension.
- **Attack vector:** Double `registerCommand` on the same channel reroutes
  a trusted channel to a malicious handler.
- **Existing mitigation:** `registerCommand` throws on duplicate channel
  registration (verified); no `*:execute` channels exist anywhere (verified
  by comment/code search across ipc handlers).
- **PR46 mitigation:** No-execute rule documented (`IPC-SECURITY.md`).
- **Residual risk:** A malicious in-main module could still register a
  _new_ confusingly-named channel; collision-throwing does not prevent
  typosquatting channels.
- **Security tests:** `apps/desktop/src/__tests__/ipc.test.ts` (collision).

## T05 — Secrets at rest or in transit (SQLite / events / logs / IPC)

- **Asset:** API keys, OAuth/refresh tokens, credentials.
- **Attacker:** A4 (reads SQLite/logs) / A1 (reads events/IPC).
- **Trust boundary:** 2, 3.
- **Attack vector:** Raw secret persisted, emitted, logged, or sent.
- **Existing mitigation:** `SecretStore` + `OSKeychainSecretStore`
  (@napi-rs/keyring) hold values; SQLite keeps only `SecretRef`/non-secret
  `credentialRef`; provider configs reject raw keys
  (`ProviderConfigSchema`); memory facts, schedules, sync records, and event
  schemas secret-scan inputs (verified in memory/schedules contracts).
- **PR46 mitigation:** Full lifecycle + forbidden-sinks list + redaction
  policy (`SECRETS.md`); `security.secret.redacted` taxonomy slot.
- **Residual risk:** Operator pastes a secret into chat text (then it is
  event-persisted as message content); renderer display redaction is
  `key=value`-shape only. See T29.
- **Security tests:** `packages/storage/src/__tests__/secrets.test.ts`
  (PR9); `memory-contracts` / `memory-extractor` credential tests
  (verified); provider-config secret-quarantine tests (PR20).

## T06 — Credential capability confusion (`secrets.use` vs `secrets.read`)

- **Asset:** Least-privilege on credentials.
- **Attacker:** A2 (tool requesting broader access) / developer error.
- **Trust boundary:** Host<->extension/tool.
- **Attack vector:** A `secrets.use` grant is treated as permission to
  display/export the key.
- **Existing mitigation:** Policy evaluator treats them as strictly distinct
  capabilities; `secrets.use` never implies `secrets.read` (verified in
  `permission-policy.ts` and `permission-core.test.ts`).
- **PR46 mitigation:** Documented in `SECURITY-BASELINE.md`;
  `security.permission.denied` taxonomy slot.
- **Residual risk:** A tool that legitimately receives _use_ can still
  exfiltrate via its own channel (use inherently exposes value to the
  callee); the boundary limits who may read, not what approved users do.
- **Security tests:** `permission-core.test.ts` "strictly separates
  secrets.use from secrets.read" (verified).

## T07 — Model text self-grants permission (prompt-injection approval)

- **Asset:** Integrity of the permission checkpoint.
- **Attacker:** A1 (poisoned content in context).
- **Trust boundary:** 3.
- **Attack vector:** Instructions in tool output/web/docs claim the user
  approved; agent proceeds without a real decision.
- **Existing mitigation:** Only `PermissionGateway`/UI decisions unblock;
  model text can never self-grant (PR29 blocked/resume design); scheduled
  runs park on `waiting_permission` (PR44); `resumeTask` replays exact
  pending calls.
- **PR46 mitigation:** Tool-lifecycle rule (`SECURITY-BASELINE.md`).
- **Residual risk:** An operator socially engineered by content text may
  manually approve; the checkpoint cannot verify human attention.
- **Security tests:** Agent-runtime blocked/resume tests (PR29);
  research-intelligence prompt-injection tests (PR36, per design doc).

## T08 — Schedule / sync / sign-in treated as an authorization grant

- **Asset:** Authorization integrity (confused deputy).
- **Attacker:** A1 (synced/remote content) / A6.
- **Trust boundary:** Host<->automation; host<->remote.
- **Attack vector:** A schedule firing, a sync payload arriving, or a
  sign-in is interpreted as approval to execute.
- **Existing mitigation:** Schedule≠grant, sync≠grant, sign-in≠grant are
  structural: launched runs still pass `PermissionManager`; synced schedules
  arrive inert (`enabled=false`); auth never implies capability (verified in
  `schedules.ts` header comments, ADR-016/017, PR45 service code).
- **PR46 mitigation:** Stated as baseline invariants
  (`SECURITY-BASELINE.md`); `security.sync.rejected` taxonomy slot.
- **Residual risk:** `allow_project`/`allow_session` policies granted earlier
  still apply to scheduled runs; a stale broad grant plus a schedule equals
  unattended execution within the grant.
- **Security tests:** Scheduler service tests (PR44); sync engine tests
  (PR45); renderer no-auto-approve tests (per design docs).

## T09 — Path traversal / absolute-path escape

- **Asset:** Files outside the project workspace.
- **Attacker:** A1 (malicious paths in tool args/IPC) / A6.
- **Trust boundary:** 2 (main<->OS fs).
- **Attack vector:** `../`, absolute paths, or UNC/drive-root paths in
  file, search, media, document, attachment, or git operations.
- **Existing mitigation:** `resolveWorkspacePath`: normalize ->
  realpath-resolve -> containment proof; traversal/absolute rejected;
  missing-tail anchored via nearest existing ancestor (verified). Applied in
  filesystem backend, media artifact store, documents ingest, workspace
  services (per design docs).
- **PR46 mitigation:** Path-security reuse contract
  (`PROJECT-ISOLATION.md`); `security.path.rejected` taxonomy slot.
- **Residual risk:** Coverage depends on every fs-touching path calling the
  policy; a new backend that forgets the call is unprotected (no mechanical
  gate verified).
- **Security tests:** Path-policy suites + per-surface traversal tests
  (PR30/PR37/PR39/PR41/PR42, per design docs).

## T10 — Symlink escape from the workspace root

- **Asset:** Same as T09.
- **Attacker:** A1/A6 (plants or names a symlink).
- **Trust boundary:** 2.
- **Attack vector:** Symlink inside the project pointing outside; TOCTOU
  swap between check and use.
- **Existing mitigation:** Realpath resolves every existing segment;
  dedicated symlink-escape rejection; directory symlinks not followed during
  traversal (verified in `path-policy.ts`, `filesystem-tool-backend.ts`).
- **PR46 mitigation:** Same as T09.
- **Residual risk:** TOCTOU between resolution and use by a concurrent
  local writer (A4) is not closed; single-user assumption only.
- **Security tests:** Symlink-escape tests in path-policy/filesystem suites
  (per design docs).

## T11 — Cross-project data leakage

- **Asset:** Per-project confidentiality (memory, documents, media,
  tasks, schedules, subscriptions).
- **Attacker:** A1/A2 (queries scoped to another project).
- **Trust boundary:** Host<->project data.
- **Attack vector:** Missing `projectId` binding on read/list/search;
  renderer displays unscoped rows.
- **Existing mitigation:** Immutable per-schedule/per-task `projectId`;
  project-scoped repositories and service checks; renderer display-only
  filtering belt-and-braces (verified pattern in ADR-015/016/017 and
  PR43–45 service code: cross-project ops rejected as project-mismatch).
- **PR46 mitigation:** Boundary definition per subsystem
  (`PROJECT-ISOLATION.md`).
- **Residual risk:** Renderer-side filtering is defense-in-depth only; any
  main-side query that omits the project predicate leaks.
- **Security tests:** Cross-project isolation tests across PR28/PR30/PR37/
  PR39/PR41/PR43/PR44/PR45 (per design docs).

## T12 — MCP tool-description poisoning

- **Asset:** Agent behavior integrity.
- **Attacker:** A2 (malicious MCP server).
- **Trust boundary:** Host<->MCP server.
- **Attack vector:** Tool descriptions containing instructions that steer
  the model or smuggle data into approvals.
- **Existing mitigation:** Tool-list invariant tests; tool execution keeps
  validate->permission->execute with user-visible capability/action/
  resource; structured result preservation; prompt/resource framing as
  untrusted (verified pattern in `mcp-advanced-security.test.ts`).
- **PR46 mitigation:** Untrusted-server framing (`EXTENSIONS.md`);
  `security.mcp.rejected` taxonomy slot.
- **Residual risk:** Descriptions are still shown to the model and the
  operator; a persuasive-but-in-policy tool can be approved by a careless
  operator (A6).
- **Security tests:** `mcp-advanced-security.test.ts` (poisoning/truncation/
  forgery suites, verified).

## T13 — Malicious MCP resources / prompts

- **Asset:** Data integrity, operator attention.
- **Attacker:** A2.
- **Trust boundary:** Host<->MCP server.
- **Attack vector:** Oversized, dangerous-URI, or secret-laden resources and
  prompts; subscription floods.
- **Existing mitigation:** URI gates + 2000-char cap, 256 KB ceilings,
  per-server/per-project caps, 300 s TTL subscription cleanup, prompt
  truncation markers (verified in `in-process-mcp-host.ts`).
- **PR46 mitigation:** Same as T12.
- **Residual risk:** Content that fits the bounds but is semantically
  malicious still reaches the model; no content-truth filter exists or is
  claimed.
- **Security tests:** `mcp-resources-prompts.test.ts`,
  `mcp-advanced-security.test.ts` (verified).

## T14 — Skill script tampering on disk

- **Asset:** Execution integrity of skill tools.
- **Attacker:** A4 (edits script between approval and run).
- **Trust boundary:** Host<->filesystem.
- **Attack vector:** Modify skill script after install/approval; execute
  attacker code with granted permission.
- **Existing mitigation:** Pre-execution SHA-256 checksum verified
  immediately before execution; mismatch blocks with re-approval required
  (verified in `skill-tool-executor.ts`); manifest checksum at install.
- **PR46 mitigation:** Tool-lifecycle integrity note
  (`SECURITY-BASELINE.md`); `security.integrity.failure` taxonomy slot.
- **Residual risk:** TOCTOU between checksum and spawn; no OS-level file
  locking/signing was verified.
- **Security tests:** `skill-execution-integrity.test.ts` (verified).

## T15 — Sandbox escape / host-environment leakage in execution

- **Asset:** Host OS, host env secrets, network.
- **Attacker:** A1 (malicious command content) / A2.
- **Trust boundary:** 2 (main<->process/container).
- **Attack vector:** Malicious command reads `process.env`, mounts host
  paths, opens network, exhausts resources, or escapes the container.
- **Existing mitigation:** Docker: `--user 1000:1000`, explicit mounts
  (read-only default, no `/etc`/`$HOME`/docker socket), `--network none`
  default, CPU/memory/PID limits, wall-clock timeout, orphan cleanup;
  local provider: env allowlist (never `process.env`), timeouts,
  cooperative abort, 256 KB ceilings (verified in `docker-provider.ts`,
  `local-sandbox-provider.ts`).
- **PR46 mitigation:** Isolation/tool-lifecycle posture
  (`SECURITY-BASELINE.md`).
- **Residual risk:** Local-process sandbox is containment, not a security
  boundary against a skilled adversary; kernel/container escapes are out of
  scope; `networkAllowed` executions are intentionally porous.
- **Security tests:** `docker-provider.test.ts`,
  `local-sandbox-provider.test.ts` (verified).

## T16 — SSRF via research fetch (metadata, intranet, cloud endpoints)

- **Asset:** Internal network, cloud instance metadata, local services.
- **Attacker:** A1 (URL in research query/content) / A3.
- **Trust boundary:** 2 (main<->network).
- **Attack vector:** Research fetch to `169.254.169.254`, RFC1918 hosts,
  or intranet URLs exfiltrating responses into results.
- **Existing mitigation:** SSRF guard rejects loopback, RFC1918, private
  IPv6, link-local, CGNAT, metadata, multicast holders (verified in
  `ssrf-guard.ts`); research is the only network egress path with this
  guard; `URL safety policy` + MIME allowlist in ai-core contracts.
- **PR46 mitigation:** Network policy (`NETWORK-SECURITY.md`);
  `security.network.blocked` taxonomy slot.
- **Residual risk:** Query-parameter exfiltration to a public attacker URL
  (e.g. `?leak=...`) is not SSRF and is not blocked; response content is
  untrusted (see T20).
- **Security tests:** Research security suites, 27 tests (PR35, per design
  doc).

## T17 — Redirect-chain and DNS-rebinding bypass of SSRF guard

- **Asset:** Same as T16.
- **Attacker:** A3 (attacker DNS + redirector).
- **Trust boundary:** 2.
- **Attack vector:** Benign first hop redirects to private IP; DNS answers
  change between check and fetch (rebinding).
- **Existing mitigation:** Manual redirect handling with per-hop scheme +
  SSRF re-validation and a hard redirect ceiling; fail-closed DNS
  (verified in `ssrf-guard.ts`, `secure-fetch.ts`).
- **PR46 mitigation:** Same as T16; private-range stance documented.
- **Residual risk:** Residual race between final validation and socket
  connect exists (no verified connection-level IP pinning); low but nonzero.
- **Security tests:** Redirect/rebinding tests in research security suite
  (per design doc).

## T18 — Browser automation navigated to dangerous scheme / local file

- **Asset:** Local files, script execution in browser context.
- **Attacker:** A1 (URL in page/tool input).
- **Trust boundary:** Host<->browser engine.
- **Attack vector:** `javascript:`, `vbscript:`, `data:`, `file:`, `blob:`
  URLs via navigate/open or page content.
- **Existing mitigation:** `browser-policy` strictly rejects those schemes
  (verified); URL guards also in ai-core browser contracts; per-action
  permission checks with elevated risk for sensitive input (verified in
  `browser-tool-executor.ts`).
- **PR46 mitigation:** `security.browser.blocked` taxonomy slot.
- **Residual risk:** An allowed `https:` page can still host XSS that acts
  within the page context; the guard covers navigation, not page content.
- **Security tests:** `browser-subsystem.test.ts` scheme tests (verified).

## T19 — Credential capture through browser form automation

- **Asset:** Operator credentials typed into automated pages.
- **Attacker:** A1 (malicious page reads exfiltrated snapshot/fill values).
- **Trust boundary:** Host<->page.
- **Attack vector:** `fill` on password fields; snapshots containing
  sensitive values persisted or displayed.
- **Existing mitigation:** Sensitive-field detection with value redaction in
  snapshots; elevated risk mapping for sensitive input (verified per
  PR34 contracts/adapter comments).
- **PR46 mitigation:** Redaction policy (`SECRETS.md`).
- **Residual risk:** Redaction is heuristic (field-name based); a custom
  credential field the detector misses is captured.
- **Security tests:** Browser security tests incl. redaction (PR34 suite,
  per design doc).

## T20 — Poisoned content becomes agent/memory truth (prompt injection)

- **Asset:** Agent behavior, long-term memory, research packages.
- **Attacker:** A1.
- **Trust boundary:** 3.
- **Attack vector:** Instructions embedded in web pages, documents, MCP
  content, or media transcripts flow into prompts, memory extraction, or
  citations and are acted on as principal instructions.
- **Existing mitigation:** Untrusted-content framing (`UNTRUSTED DOCUMENT
CONTENT`, `frameResearchContent`, transcript framing); verbatim-only
  evidence (≤2000 chars, non-verbatim throws); memory extractor skips
  credentials and generic text; tool-list invariance tests (verified across
  memory/research/documents contracts).
- **PR46 mitigation:** Framing requirements restated in baseline/isolation
  docs.
- **Residual risk:** Framing is advisory to the model, not a control; a
  capable model may still follow embedded instructions. No deterministic
  instruction-hierarchy enforcement was verified.
- **Security tests:** Prompt-injection/tool-poisoning tests (PR36),
  injection-inert E2E (PR37), framed-injection tests (PR39/PR40)
  (per design docs).

## T21 — Malicious or weaponized document (bomb, parser exploit, formula)

- **Asset:** Availability, parser integrity, spreadsheet operators.
- **Attacker:** A1 (shares/uploads a file).
- **Trust boundary:** 3.
- **Attack vector:** Decompression bomb, malformed PDF crashing the parser,
  CSV formula injection into exports, oversized file OOM.
- **Existing mitigation:** Hand-rolled dependency-free parsers (txt/md/json/
  CSV/minimal `%PDF-`-validated), centralized `DOCUMENT_MAX_*` bounds,
  magic-byte + bomb validation in media store, 64 KB ingest ceilings,
  project-scoped ingestion with path-policy containment (verified pattern per
  PR37/PR39 design docs + `MediaArtifactStore` usage in main).
- **PR46 mitigation:** `security.document.rejected` taxonomy slot.
- **Residual risk:** Hand-rolled PDF parsing is minimal by design (misses
  exotic constructs; fails closed, which is availability loss, not breach);
  CSV formulas are inert in-app but dangerous if the operator copy-pastes
  into a spreadsheet — operator education only.
- **Security tests:** Parser/normalizer/chunker suites + oversized/malformed
  tests (PR37/PR39, per design docs).

## T22 — Malicious extension manifest (capability overreach, squatting)

- **Asset:** Extension trust integrity.
- **Attacker:** A2.
- **Trust boundary:** 4.
- **Attack vector:** Manifest declares broad capabilities, ≤16 tools with
  colliding IDs, oversized payloads, secret-shaped defaults.
- **Existing mitigation:** `ExtensionManifestSchema` validation (slug id,
  SemVer, closed capability enum, ≤16 tools, 64 KB cap, secret scan);
  lifecycle Installed->Enabled->Active with per-project bindings defaulting
  to false (verified per PR32 design + phase-0 inventory).
- **PR46 mitigation:** Manifest/trust/lifecycle contract (`EXTENSIONS.md`);
  `security.plugin.rejected` taxonomy slot.
- **Residual risk:** Manifest review is syntactic; a well-formed malicious
  extension still passes — user judgment is the control. No marketplace
  review, sandbox process, or auto-update verification exists (explicit
  non-goals).
- **Security tests:** 80 plugin tests incl. manifest validation (PR32, per
  design doc).

## T23 — Stale tool executed after definition change (trust invalidation)

- **Asset:** Permission-grant integrity.
- **Attacker:** A2 (updates tool semantics after approval).
- **Trust boundary:** 4.
- **Attack vector:** Tool approved under one definition; server swaps the
  binary/semantics (hash changes); old grant still honored.
- **Existing mitigation:** Deterministic SHA-256 definition hashes; trust
  invalidation on hash change (trust != permission); `tools/list_changed`
  resync (verified pattern in `tool-converter.ts`, `tool-registry.ts`,
  `in-process-mcp-host.ts`).
- **PR46 mitigation:** Same as T22.
- **Residual risk:** Race between definition change and resync delivery;
  in-flight executions under the old definition complete.
- **Security tests:** Tool-registry hash/invalidation + list_changed tests
  (PR25/PR38, per design docs).

## T24 — Local filesystem attacker tampers SQLite / app files

- **Asset:** Integrity of events, policies, audit history, binaries.
- **Attacker:** A4.
- **Trust boundary:** 5 — explicitly undefended cryptographically.
- **Attack vector:** Direct edit of SQLite rows (events, policies, audit),
  swapping skill/extension files, editing config.
- **Existing mitigation:** Append-only API discipline (no update/delete
  event APIs), `UNIQUE(conversationId, sequence)`, OS file permissions by
  default; skill pre-execution checksum detects _that_ tamper class at run
  time (T14).
- **PR46 mitigation:** Explicit persistence assumption documented
  (`SECURITY-BASELINE.md`): **no cryptographic tamper resistance against a
  local filesystem attacker is claimed or provided**; `security.integrity.
failure` taxonomy slot for detectable cases only.
- **Residual risk:** **A local filesystem attacker can rewrite history,
  forge events, and alter policies undetectably.** Full-disk encryption and
  OS user separation are the only mitigations, and they are environmental,
  not app-provided.
- **Security tests:** None possible for this class inside the app; restart-
  recovery tests prove durability, not integrity.

## T25 — Event forgery (extension emits core/capability events)

- **Asset:** Event-stream authority.
- **Attacker:** A2.
- **Trust boundary:** 4.
- **Attack vector:** Extension crafts `message.completed`,
  `permission.granted`, or `tool.call.completed` to fake history/approval.
- **Existing mitigation:** `extension.custom`-only event factory — core
  event forgery structurally impossible through the extension API; hash-match
  forgery guard on surfaces (verified per PR32/PR33 design + phase-0).
- **PR46 mitigation:** `security.integrity.failure` taxonomy slot.
- **Residual risk:** Anything running in main with direct `EventBus` access
  can publish anything; the boundary holds only at the extension API, not
  inside main.
- **Security tests:** Extension event-boundary tests (PR32); surface
  forgery-guard tests (PR33) (per design docs).

## T26 — Untrusted sync-remote content (secret/path smuggling, auto-merge)

- **Asset:** Local data integrity and confidentiality.
- **Attacker:** A1 (compromised/second device, malicious server responses
  through the transport port).
- **Trust boundary:** Host<->remote.
- **Attack vector:** Synced records carrying secrets, absolute paths, or
  executable schedules; silent auto-merge of structural conflicts.
- **Existing mitigation:** Closed syncable-entity allowlist; secret/path
  refusal in both directions; synced schedules inert; scalar LWW vs explicit
  Keep-local/Keep-remote conflicts (never silent); tombstones; SecretStore-
  only refresh tokens (verified in ai-core `sync.ts` contracts and ADR-017).
- **PR46 mitigation:** Sync-trust posture (`SECURITY-BASELINE.md`);
  `security.sync.rejected` taxonomy slot.
- **Residual risk:** Desktop `SyncService` is a fail-closed stub in this
  tree (`getSyncService()` throws; IPC stubs fail closed — verified):
  real-transport risks are future work; LWW scalars can still lose data
  silently by design.
- **Security tests:** Sync engine/queue/transport suites (PR45, per design
  doc); IPC malformed-resolve rejection (verified pattern).

## T27 — Unauthorized voice capture / transcript leakage (realtime)

- **Asset:** Microphone audio, transcripts.
- **Attacker:** A6 (accidental capture) / A1 (reads retained transcripts).
- **Trust boundary:** 2 (main<->mic), 1 (transcripts->renderer).
- **Attack vector:** Session started without consent; partial audio or
  transcripts retained/exfiltrated; capture continues after UI closed.
- **Existing mitigation:** Permission-gated lifecycle (capture-start =
  high risk), per-chunk capture re-checks, one session per project,
  idempotent interruption/cleanup, ephemeral partials vs durable
  lifecycle/finals, bounded retained-transcript buffer, mic released on
  stop (verified per PR40 design + phase-0).
- **PR46 mitigation:** Baseline capture rule (`SECURITY-BASELINE.md`).
- **Residual risk:** OS-level mic indicator is the only out-of-band signal;
  a main-process compromise hears everything (see T01).
- **Security tests:** Realtime permission/isolation/forgery suites + E2E
  (PR40, per design doc).

## T28 — Supply-chain compromise (malicious/vulnerable dependency)

- **Asset:** Whole application.
- **Attacker:** A5.
- **Trust boundary:** Build/developer machine.
- **Attack vector:** Malicious update of a pinned package; typosquat;
  compromised maintainer credentials.
- **Existing mitigation:** Pinned versions (AGENTS.md §4 toolchain table);
  zero-new-dependency discipline per PR; quarantine rules (provider/MCP SDK
  isolation) enforced by `eslint-plugin-boundaries` +
  `scripts/validate-dependencies.mjs`; no auto-update/marketplace (explicit
  non-goal).
- **PR46 mitigation:** Supply-chain posture (`SECURITY-BASELINE.md`).
- **Residual risk:** No lockfile-integrity verification, no SBOM, no
  vulnerability scanning, and no signature verification were verified in
  this PR; pinning slows but does not stop a compromised pinned version.
- **Security tests:** `scripts/validate-dependencies.test.mjs` (19 tests);
  boundary lint (mechanical, not adversarial).

## T29 — Operator-pasted secret retained in events/memory/logs

- **Asset:** Credential confidentiality.
- **Attacker:** A4 (reads retained data) / A1 (reads displayed data).
- **Trust boundary:** 2, 3.
- **Attack vector:** User pastes an API key into chat; it persists as
  message content, gets extracted into memory, or renders in UI/logs.
- **Existing mitigation:** Memory extractor + memory/project validators
  reject credential-shaped content (verified); renderer redacts
  `key=value`-shaped fragments; identity fields reject secret shapes
  (verified in memory + account/schedule validators).
- **PR46 mitigation:** Redaction policy + forbidden sinks (`SECRETS.md`).
- **Residual risk:** Message-event content itself is NOT scrubbed (events
  are verbatim history); a pasted secret lives in SQLite until the
  conversation data is deleted. No secret-purge affordance was verified.
- **Security tests:** Memory credential-rejection tests (verified);
  display-redaction tests in renderer suites (per design docs).

## T30 — Resource-exhaustion DoS (unbounded inputs, queues, outputs)

- **Asset:** Availability, operator attention.
- **Attacker:** A1/A2 (floods) / A6 (accidental).
- **Trust boundary:** All ingress.
- **Attack vector:** Oversized tool results, unbounded subscriptions,
  infinite schedules, transcript floods, event storms.
- **Existing mitigation:** 256 KB result ceilings (MCP, execution, resource
  reads) with truncation markers; per-project subscription caps + TTL;
  schedule caps (32/8/60 s/50/1-catch-up); single scheduler timer;
  per-page promise queues; bounded renderer lists (50/100/200 caps);
  idempotent cancel/unsubscribe (verified across execution/MCP/scheduler/
  batcher code).
- **PR46 mitigation:** Logging-bounds and cap inventory
  (`SECURITY-BASELINE.md`).
- **Residual risk:** Ceilings truncate, they don't authenticate; a hostile
  server can keep the operator busy indefinitely within the caps.
  No rate-limiting on IPC ingress was verified.
- **Security tests:** Ceiling/cap tests across MCP/execution/scheduler/
  renderer suites (per design docs).

---

## PR46 deliverables map

| Deliverable                                    | Covers                                                                                  |
| :--------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `SECURITY-BASELINE.md`                         | Posture inventory: T01–T30 status summary                                               |
| `IPC-SECURITY.md`                              | T01–T04, T27-audio                                                                      |
| `SECRETS.md`                                   | T05, T06, T19, T29                                                                      |
| `PROJECT-ISOLATION.md`                         | T09–T11, T21                                                                            |
| `NETWORK-SECURITY.md`                          | T16, T17                                                                                |
| `EXTENSIONS.md`                                | T12, T13, T22, T23, T25                                                                 |
| `INCIDENT-RESPONSE.md`                         | Operator playbook across all                                                            |
| `SecurityEventSchema` (`security.*`, 11 types) | Audit taxonomy slots for T01–T05, T08, T09, T13, T14, T16, T18, T22, T23, T24, T25, T26 |
