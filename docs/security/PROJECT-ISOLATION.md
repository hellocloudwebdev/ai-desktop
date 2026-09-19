# Project Isolation — Boundaries per Subsystem (PR46)

A project (`projectId`) is the unit of data separation. Binding is
immutable where it matters (schedules, background tasks) and enforced
main-side on every operation; renderer filtering is display-only
belt-and-braces (ADR-015/016/017 pattern).

## 1. Boundary definition per subsystem

| Subsystem                                                  | Binding mechanism                                                                                                                                      | Verified basis                           |
| :--------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| Agent tasks (foreground/background)                        | Immutable `projectId` per task; cross-project ops rejected as project-mismatch; downward-only cancel never touches siblings                            | PR29/PR43 services                       |
| Coding workspace / files / search / diagnostics / terminal | All fs ops resolve through `resolveWorkspacePath` against the CodingAgentService project->root map; unregistered projects fail closed (`NO_WORKSPACE`) | `path-policy.ts`, workspace/git services |
| Memory                                                     | `scopeLevel` global/project; project facts require `projectId`; retrieval propagates `projectId`; deletion cleanup on project remove                   | `packages/memory`                        |
| Documents / attachments / media                            | Project-scoped repositories and byte stores; checksum dedupe within project; cross-project leakage proofs                                              | PR37/PR39 suites                         |
| Browser sessions                                           | Project-level session isolation in `BrowserService`                                                                                                    | PR34                                     |
| Schedules / runs                                           | Immutable per-schedule `projectId` on every op; edit form locks project; runs carry the bound id                                                       | `schedules.ts`, PR44 service             |
| Accounts / sync                                            | Project binding travels as opaque id; paths never sync; per-device re-anchoring through path policy                                                    | ADR-017, `sync.ts`                       |
| MCP subscriptions                                          | Per-project subscriptions, 64 cap, 300 s TTL, disconnect cleanup                                                                                       | `in-process-mcp-host.ts`                 |
| Permissions                                                | `allow_project` policies scoped strictly to `projectId`; session grants vanish on restart                                                              | PR24                                     |

## 2. Path-security reuse (mandatory)

Every filesystem touch reuses the single policy
(`apps/desktop/src/main/agent/filesystem/path-policy.ts`, verified):

1. Normalize -> realpath-resolve -> containment proof against the resolved
   root. String-prefix checks are forbidden.
2. Traversal (`..`), absolute outside paths, and symlink escapes rejected
   (`OUTSIDE_WORKSPACE` / symlink errors).
3. Missing-tail write targets anchored through the nearest existing
   ancestor (the remainder cannot contain symlinks because it does not
   exist yet).
4. Directory symlinks never followed during traversal/search.
5. No second filesystem authority: workspace, terminal, git, documents,
   media, and coding backends all delegate to this policy.

Audit slot for violations: `security.path.rejected` (with bounded
`entityType`/`entityId`/`projectId`, never the raw absolute path — the
reason carries the violation class, not the bytes).

## 3. Test pointers

- Path policy: traversal/absolute/symlink/nested/rename/delete-escape
  suites with sentinels (PR30/PR41/PR42; `path-policy` + filesystem +
  workspace + git security tests).
- Isolation proofs: identical-file A/B isolation (PR37), vision/isolation
  (PR39), interruption/isolation (PR40), file/conflict/search/diagnostics/
  isolation/terminal (PR41), repository isolation (PR42), lifecycle/
  recovery/E2E (PR43/PR44/PR45).
- Renderer: display-only filter tests and disconnect-requery tests prove
  the UI never rewrites the bound `projectId` (PR43–PR45 renderer suites).

## 4. Residual risks (honest)

- Enforcement is per-call-site: a new backend that forgets the policy call
  is unprotected (no mechanical gate verified).
- TOCTOU between check and use against a concurrent local writer is not
  closed (single-user assumption).
- Renderer filtering is not a control; any main-side query omitting the
  project predicate leaks.
