# Secrets Management — Lifecycle, Sinks, Redaction (PR46)

Canonical secret handling for `ai-desktop`. Mechanism verified in
`packages/storage/src/secrets/` (`SecretStore`, `OSKeychainSecretStore`,
branded `SecretRef`) and consuming contracts (providers, memory, schedules,
sync, accounts).

## 1. Secret lifecycle: `SecretStore` -> `secrets.use` -> operation

1. **Store.** Values live only in the OS keychain via `SecretStore`
   (`set`/`get`/`delete`/`has`; missing (`null`) and backend failure
   (`SecretBackendError`) stay distinguishable). `set` never returns or
   logs the value.
2. **Reference.** Code, configs, events, and SQLite carry only `SecretRef`
   (`app/provider/<id>/api-key` shape; rejects whitespace, `=`,
   uppercase, embedded values) or non-secret `credentialRef`.
3. **Use.** At operation time the holder resolves the ref through the
   `SecretStore` port and passes the value directly to the callee (provider
   SDK, MCP stdio env via `{ secretRef }` objects resolved at connect).
   The value never lands in an event, log, error, IPC payload, or row.
4. **Rotate / delete.** Rotation = `set` same ref (safe replacement);
   removal = idempotent `delete`. Refresh tokens live **exclusively** in
   the `SecretStore` (PR45), never in `AccountRecord` rows.

## 2. The `secrets.use` != `secrets.read` rule

A grant of `secrets.use` authorizes _passing_ the credential to the named
operation. It never authorizes displaying, exporting, or persisting the
value (`secrets.read` is a strictly separate capability; verified deny-
separation in `packages/permissions`). Use still exposes the value to the
callee itself — scope grants narrowly.

## 3. Forbidden sinks

Raw secret values must never reach:

- SQLite rows (any table, including events, audit, memory, sync payloads)
- `AIEvent` payloads or `security.*.reason` fields (producers must scrub)
- IPC payloads in either direction (credentials never cross IPC)
- Logs, error messages, envelopes, or truncation snippets
- Renderer state, props, form defaults, or displayed text
- Provider/model display names, schedule names/prompts, memory fact
  content, sync records, MCP env literals (use `{ secretRef }` objects)
- Git status/diff output surfaces and terminal output rendering

Schema-level guards exist at: provider config, memory facts, schedule
name/prompt/description, sync record payloads, account identity fields,
extension manifests, MCP server configs.

## 4. Redaction policy

- Renderer display redacts `key=value`-shaped secret fragments (API keys,
  tokens, passwords, bearer material); plain prose merely mentioning the
  words passes through.
- Identity/name fields reject secret-shaped input outright (never a
  smuggling channel).
- Bounded buffers keep truncated snippets (`error <= 2000`, titles
  `<= 120`); truncation must not cut in a way that reassembles secrets —
  prefer dropping over partial masking.
- Audit slot for scrub actions: `security.secret.redacted`.

## 5. Known boundary (honest)

Free-form chat text is verbatim history: an operator-pasted secret inside
message content persists in SQLite until the conversation data is deleted
(T29). Memory extraction refuses to memorize it, and display redaction
limits exposure, but **no purge affordance was verified in this PR**.
Treat pasted secrets as compromised and rotate them via `SecretStore`.
