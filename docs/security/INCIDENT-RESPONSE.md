# Incident Response — Local-First Guidance (PR46)

`ai-desktop` is a local-first desktop app: there is no server-side
security team, no remote telemetry, and no kill switch. This playbook is
documentation only (no in-app incident tooling exists in this PR).

## 1. What to collect (and where it lives)

1. **Event history:** the append-only SQLite event log (WAL mode) via the
   app's storage; filter `permission.*`, `task.background.*`,
   `schedule.run.*`, `sync.*`, and (once producers land) `security.*`
   types. Events are authoritative history — do not edit them.
2. **Permission audit rows:** `permission_audit` table (capability, action,
   resource, scope, risk, decision, tool call ids — no secrets).
3. **Renderer-visible indicators:** Activity surface (bounded 200-item
   view), Task Center timelines (100-item cap), schedule run history
   (50 rows), sync conflict list.
4. **Local files:** skill/extension install dirs (checksums in manifests),
   workspace files named in tool results, media-artifact store metadata.

## 2. Credential rotation via `SecretStore`

If a secret may have leaked (pasted into chat, shown in an error,
entered into an untrusted field):

1. Rotate the credential **at the provider** first (the app cannot revoke
   third-party keys).
2. `SecretStore.set` the same `SecretRef` with the new value (safe
   replacement semantics).
3. `revoke()` any session/project permission policies that referenced the
   exposed context; subsequent checks return `requires_user`.
4. Treat verbatim chat history containing the secret as compromised data
   at rest (T29 — no verified purge affordance); prefer deleting the
   affected local conversation data and re-importing cleanly.
5. Never paste the new secret into chat, tool inputs, or config fields to
   "test" it — resolve it through the `SecretStore` path only.

## 3. What is and isn't logged (honest scope)

- **Logged:** permission decisions (without secrets), tool lifecycle
  transitions, task/schedule/run state changes, sync entity/version
  metadata, IPC validation failures (shape, not values).
- **Never logged:** raw secret values, keychain contents, full
  `process.env`, microphone audio (only transcripts per retention rules),
  renderer-internal state.
- **Not available:** tamper-evidence feed (see T24 — a local filesystem
  attacker can rewrite the log itself), remote audit trail, central
  alerting.

## 4. Containment actions available in-app

- Cancel running work: chat cancel, agent cancel, coding cancel,
  background-task cancel, terminal session cleanup (all idempotent).
- `permission:revoke` to clear session + project grants.
- Disable schedules (parks future ticks; running tasks keep their own
  lifecycle — delete != cancel).
- Disable/uninstall extensions per project; disconnect MCP servers
  (subscriptions cleaned up, 300 s TTL otherwise).
- Pause sync (parks locally on this device); sign-out preserves local data
  (delete != wipe) — use before handing diagnostics to anyone.

## 5. Explicit limits

- No remote wipe, no device revocation, no fleet administration.
- No automatic conflict resolution and no auto-approval anywhere: every
  recovery resumes parked, never running.
- If the local machine itself is compromised (malware with user
  privileges), none of the in-app controls hold — re-image and rotate all
  credentials from a clean device.
