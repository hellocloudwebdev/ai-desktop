# PR35 Error Log

A record of the errors encountered while implementing PR35 (Web Research &
Internet Connectivity Foundation), what caused each one, and how it was
resolved. Entries marked **pre-existing** existed before PR35 and were left
alone except where they blocked the verification gates.

---

## 1. Toolchain and environment

### pnpm missing; corepack permission denied

- **Error:** `pnpm: command not found`, then `Internal Error: EACCES:
permission denied, symlink ... -> '/usr/bin/pnpm'` from `corepack enable`.
- **Cause:** No pnpm on PATH, and corepack could not write its symlink into
  the system prefix.
- **Fix:** Installed pnpm to the user-local prefix
  (`npm install -g pnpm@11.25.0 --prefix "$HOME/.local"`) and exported
  `$HOME/.local/bin` onto PATH. Status: resolved.

### pnpm must run from the repo root

- **Error:** `[ERR_PNPM_NO_PKG_MANIFEST] No package.json found in
/home/hellocloudwebdev/.zcode/workspace/default`.
- **Cause:** The shell starts in the workspace root, not the `ai-desktop`
  repo root, and each shell call resets the working directory.
- **Fix:** Prefix every pnpm/vitest command with
  `cd /home/hellocloudwebdev/.zcode/workspace/default/ai-desktop` in the
  same command. Status: resolved (workflow note, no code change).

### Native build approval gate

- **Error:** `pnpm --filter ... typecheck` failed inside a `pnpm install`
  pre-check with `Run "pnpm approve-builds" to pick which dependencies
should be allowed to run scripts`.
- **Cause:** pnpm 11 blocks install scripts (e.g. `@google/genai`
  preinstall) until approved.
- **Fix:** Ran `pnpm approve-builds --all`. Side effect: one local-only line
  in `pnpm-workspace.yaml` (`"@google/genai": true`). Status: resolved;
  the file change is environment provisioning, not a dependency change.

---

## 2. ai-core contract errors

### Block-scoped variable used before declaration

- **Error:** `src/research.ts(142,34): error TS2448: Block-scoped variable
'MAX_RESEARCH_CONTENT_CHARS' used before its declaration` (plus TS2454,
  and the same for `MAX_RESEARCH_DOCUMENT_CHARS`).
- **Cause:** The limits block was placed after the Zod schemas that
  reference it.
- **Fix:** Moved the ceiling constants above the schemas that use them.
  Status: resolved.

### Dropped MIME/TTL block after an edit

- **Error:** `Module '"./research.js"' has no exported member
'ALLOWED_RESPONSE_MIME_TYPES'` (plus `isAllowedResponseMimeType`,
  `RESEARCH_CACHE_TTL_MS`, `RESEARCH_TIMEOUTS_MS`).
- **Cause:** An edit that relocated the limits block accidentally deleted
  the MIME/TTL section.
- **Fix:** Re-added the block in the correct position and re-ran typecheck.
  Status: resolved.

---

## 3. Desktop module resolution (unbuilt workspace)

- **Error:** `Cannot find module '@ai-desktop/permissions'` (and skills,
  memory, storage, agent-runtime) across `apps/desktop`, while
  `@ai-desktop/shared` and `@ai-desktop/ai-core` resolved fine.
- **Cause:** Desktop's tsconfig only maps `shared`/`ai-core` to source; all
  other workspace packages resolve via `dist/`, which had never been built
  in this environment. Pre-existing environment state, not a PR35 bug.
- **Fix:** Built the workspace dependencies once
  (`pnpm --filter ... build` for shared, ai-core, permissions, skills,
  memory, execution, storage, providers, plugins, agent-runtime).
  Status: resolved.

---

## 4. PR35 code bugs caught by typecheck and tests

### Wrong relative import depth in web-reader

- **Error:** `Cannot find module '../../adapters/web/web-reader.js'` (test)
  and `Cannot find module '../research-errors.js'` (adapter source).
- **Cause:** `adapters/web/` is two levels below `research/`, so `../`
  escapes to `main/` instead of staying in `research/`.
- **Fix:** Corrected to `../../research-errors.js` /
  `../adapters/web/web-reader.js` as appropriate per file depth.
  Status: resolved.

### YouTube adapter missing `provider`

- **Error:** `Argument of type 'YoutubeResearchAdapter' is not assignable
to parameter of type '{ provider: string; }'`.
- **Cause:** The adapter exposed `metadataProvider` but never declared the
  `provider` field the router requires.
- **Fix:** Added `readonly provider = "youtube-oembed"` (per-operation
  provider strings still ride on results). Status: resolved.

### Branded SurfaceId in executor stamp

- **Error:** `Type 'string' is not assignable to type 'SurfaceId'`.
- **Cause:** The search table descriptor used a plain string id.
- **Fix:** Cast through `as never`, matching the existing test precedent
  for stamp-only descriptors. Status: resolved.

### Router registered shims instead of real adapters

- **Error (test failure):** `ResearchProviderError: Adapter cannot search`
  in the service search test.
- **Cause:** The service constructor registered `asAdapterLike(...)` shells
  (provider + health only) instead of the real adapter instances, so the
  route callback's cast to `SearchProvider` found no `search` method.
- **Fix:** Register the concrete adapter objects; deleted the shim helper.
  Status: resolved.

### WebPageReader missing `health()`

- **Error:** `Argument of type 'WebPageReader' is not assignable to
parameter of type 'ResearchAdapterLike'`.
- **Cause:** The router contract requires `health()`; the reader interface
  did not declare it.
- **Fix:** Added `health()` to `WebPageReader`, `StaticWebReader`
  (`available`), and `JinaReaderAdapter` (`authRequired` when a key ref
  lacks a resolver). Status: resolved.

### Cache test used long-expired timestamps

- **Error (test failure):** Eviction test expected `k3` present but got
  `undefined`.
- **Cause:** Test bug — entries used `retrievedAt: 1, expiresAt: 999999`,
  which is expired against the real clock, so `get` treated them as dead.
- **Fix:** Based test timestamps on `Date.now()`. Status: resolved.

### No-subprocess check flagged regex `.exec()` calls

- **Error (test failure):** Offenders listed as
  `adapters/rss/rss-research.ts`, `adapters/web/web-reader.ts`,
  `adapters/youtube/youtube-research.ts`.
- **Cause:** Test bug — the naive `/exec\s*\(/` pattern matched
  `RegExp.exec(` calls, not subprocess execution.
- **Fix:** Tightened the check to `child_process` imports plus bare
  `spawn|exec|execFile` calls not preceded by `.`. Status: resolved.

### Jina adapter ignored `options.fetchFn`

- **Error (test failure):** `expected null to be 'Bearer test-key'` — the
  auth-injecting wrapper never ran.
- **Cause:** `StaticWebReader.read` accepted `fetchFn` in its options type
  but always used the constructor-injected one.
- **Fix:** Honor `options.fetchFn` in `read()`. Status: resolved.

### Minor lint/type nits

- `'opts' is defined but never used` in a service test stub — removed the
  unused parameter.
- `Property 'message' does not exist on type 'Error |
GithubResultContent'` — restructured the catch to cast `unknown`.
  Status: both resolved.

---

## 5. Cancellation and timeout race (unhandled AbortError)

This was the hardest bug in PR35 and took a bisect to isolate.

- **Symptom:** All web-reader tests passed, but vitest reported
  `Unhandled Rejection — AbortError: This operation was aborted` from
  `fetchWithRedirectPolicy`, attributed to whatever test ran after the
  cancellation test.
- **Bisect:** Isolated runs showed the pre-aborted cancellation path (not
  the timeout path) orphaned a live fetch: `withResearchTimeout` rejected
  immediately on the aborted signal, but `_readInner(...)` had already
  started as an eagerly evaluated argument, so its fetch rejected later
  with nobody observing the exact chain the test exercised.
- **Second symptom after the first fix:** the timeout test then failed
  with `CANCELLED` instead of `TIMEOUT`, because the timer's `onTimeout`
  abort fired the controller's own abort listener first (AbortError won
  the race against TimeoutError). A third symptom — a raw `AbortError`
  escaping `throwIfResearchAborted` outside try/catch — failed the
  canonical-code assertion.
- **Fix (three parts):**
  1. `throwIfResearchAborted` moved inside the try/catch in every adapter
     so raw aborts canonicalize to `CANCELLED`.
  2. New `createLinkedAbortController(parent)` helper: adapters fetch on
     the child signal so timeouts and cancellation actually stop the HTTP
     request instead of leaving detached network work.
  3. `withResearchTimeout` takes the _parent_ signal for its abort
     listener plus an `onTimeout` hook that aborts the child — so timeout
     yields `TIMEOUT` and cancellation yields `CANCELLED` deterministically.
- **Status:** resolved; reader + security suites green with zero unhandled
  errors.

---

## 6. SQLite test environment (pre-existing)

### Missing tables: `main.events does not exist`

- **Error:** 50 storage failures and ~24 desktop failures, all
  `PrismaClientKnownRequestError: The table main.<name> does not exist`.
- **Cause:** Tests copy a template DB (`prisma/dev.db`, gitignored) that
  did not exist in this environment; 13 test files hardcoded the author's
  Windows path `D:/Packages/ai-desktop/prisma/dev.db`, so the copy silently
  skipped and tests ran against an empty database.
- **Fix:** Normalized the 13 files to the repo-relative template
  (`path.resolve(__dirname, "../../../../prisma/dev.db")`, the pattern
  `extension-service.test.ts` already used) with the Windows path kept as
  fallback; provisioned the gitignored local DB with
  `prisma migrate deploy` + `prisma db push` (push was needed because the
  schema has 9 models but migrations only create 3 tables — PR22/24/26/28
  added models without migrations). Test-harness-only changes; no
  production code touched. Status: resolved.

### `coding-e2e` failure is pre-existing

- **Error:** `expected 'failed' to be 'completed'` in
  `fixes the failing test and verifies with real tool output`.
- **Cause:** Unknown, but verified unrelated to PR35: the test fails
  identically on the pristine PR34 tree with all PR35 changes stashed.
- **Status:** pre-existing, left alone. Full suite is 989 passing with
  this as the single failure.

### Migration created the DB in the wrong directory

- **Error:** After `migrate deploy`, `prisma/dev.db` still missing; the
  file had landed at `prisma/prisma/dev.db`.
- **Cause:** The relative `DATABASE_URL=file:./prisma/dev.db` resolved
  against the process cwd rather than the schema location.
- **Fix:** Moved the file into place with an absolute `DATABASE_URL`.
  Status: resolved.

---

## 7. Verification gates

- **Prettier:** 25 files flagged after implementation, plus 13 harness
  files after the template-path edit — fixed with `prettier --write`,
  gate now passes.
- **Final gate status:** `format:check` pass, `architecture:check` pass
  (13 packages, 332 files, 1692 imports), `typecheck` 13/13 pass, `lint`
  13/13 pass, `build` 13/13 pass, tests 989 passing with the one
  pre-existing `coding-e2e` failure above.
