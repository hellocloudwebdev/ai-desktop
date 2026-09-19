# IPC Security — Channel Contract Requirements (PR46)

Normative rules for every IPC channel in `apps/desktop`. The mechanism
described here is verified in `apps/desktop/src/main/ipc/index.ts`
(`IpcRegistry`) and `apps/desktop/src/preload/index.ts` (`window.api`).

## 1. Channel contract requirements

1. Every command channel registers once via `registerCommand` with a Zod
   schema; **validation runs in main before the handler executes**.
   Handlers never see unvalidated input.
2. Every subscription command (`*:subscribe` / list/get patterns) binds the
   subscription to the calling `event.sender` WebContents; destroy cleans
   up subscriptions, pending batches, and timers.
3. Every response uses the envelope `{ ok: true, value }` or
   `{ ok: false, error: { code, message } }`. No stacks, no credentials, no
   absolute-path internals beyond what the feature requires.
4. No channel name may collide: double registration throws. Channel names
   follow `<domain>:<verb>` / `<domain>:<noun>-<verb>` (e.g.
   `browser:page-open`, `schedules:run-now`).

## 2. Sender validation

- `invoke` handlers receive the `IpcMainInvokeEvent`; subscriptions use
  `event.sender` as the delivery target — never a renderer-supplied
  WebContents id.
- Handlers must not trust renderer-supplied identity: `projectId`,
  `conversationId`, and ids are **authorization hints re-checked
  main-side** (project binding, path policy, permission check), never
  proof.
- The preload bridge passes arguments through verbatim; it performs no
  authorization. All enforcement lives in main.

## 3. Input bounds

- Schemas enforce type, length, and value bounds (see per-domain contracts:
  base64 ingest ceilings, `name <= 120`, `prompt <= 4000`, 64 KB manifest
  cap, 256 KB result ceilings).
- Oversized or malformed input fails with `VALIDATION_ERROR` before any
  service runs. Audit slot: `security.ipc.rejected`.

## 4. Error hygiene

- Handler exceptions map to `HANDLER_ERROR` with `err.message` only.
- Services prefer fail-closed `CODE: message` errors with no secret echo
  (e.g. `SyncService is not available`, `NO_WORKSPACE`).
- Do not forward third-party error objects verbatim; extract a stable code
  and a scrubbed message. (Known gap, T03: no global envelope scrubber.)

## 5. No-execute rule

- There is intentionally **no** `<domain>:execute` channel in any domain:
  no `surface:execute`, `browser:execute`, `research:execute`,
  `mcp:execute`, `realtime:execute`, `workspace:execute`,
  `filesystem:execute`, `shell:execute`, `node:execute`, `git:execute`,
  `background-tasks:execute`, `schedules:execute`, `account:execute`, or
  `sync:execute` (verified by search). Execution flows only through the
  universal ToolExecutor lifecycle behind the permission checkpoint.
- Surface actions (`surface:action`) route through the existing tool router;
  they do not invent a second execution path.

## 6. Renderer obligations

- Renderer accesses privileged function only through `window.api`. Direct
  Node/Electron/fs/child_process imports in renderer sources are forbidden
  (asserted per-surface in tests).
- Renderer never retries privileged operations in a loop and never
  auto-approves: permission banners resolve only through the existing
  permission UI path.
