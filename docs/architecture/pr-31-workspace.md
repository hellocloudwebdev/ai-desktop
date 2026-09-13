# PR31 — Workspace Foundation

## Terminology

- **Workspace**: the UI container composing multiple surfaces. Owns layout only.
- **Project**: the logical boundary already used by tasks, memory, tools,
  permissions, and execution. The workspace never redefines it.
- **Surface**: visible content — `chat`, `coding`, `tasks`, `activity`, `files`
  (constrained enum in `renderer/workspace/types.ts`).
- **Panel**: layout region (left navigation, center main, right inspector)
  containing a surface, with `visible` + clamped `width`.

## Layout

```
Header (brand, conversation badge, panel toggles, IPC/streaming status)
Left (248px default, 180–420) | Center (flex) | Right (320px default, 220–480)
Composer (chat input or coding prompt, routed by active surface)
```

Panels collapse independently, resize via drag handle (pointer) or keyboard
(Arrows ±8px, Shift ±32px, Home resets), double-click resets to default.
Widths persist; collapsed state persists. Below usable widths the user
collapses a panel — no drawer/overlay system (desktop-first, out of scope).

## State ownership

| Owner                                                            | State                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Workspace store (`renderer/workspace/`, useReducer, no new deps) | activeSurface, activeProjectId, activeConversationId/taskId (presentation selection), panel visibility/widths |
| Backend services (unchanged)                                     | messages, models, permissions, skills, memories, tasks, events, coding execution                              |
| Transient (never persisted)                                      | streaming flags, input text, hover, drag                                                                      |

Project switch clears `activeTaskId` in the reducer so Project A task context
never silently persists under Project B.

## Persistence

Renderer-local versioned `localStorage` (`ai-desktop.workspace.v1`,
`{version: 1, ...}`). No Prisma migration, no new IPC channel, no
`workspace:getEverything`. Malformed/stale payloads fall back to safe
defaults. Conversation/model/task history already persists through existing
mechanisms (SQLite WAL, `ConversationModelRecord`, event replay).

## IPC

None added. The workspace reuses every existing typed channel
(`chat:*`, `agent:*`, `coding:*`, `memory:*`, `skills:*`, `permission:*`,
`provider:*`, `conversation:*`). Verified by test (no `workspace:` channel).

## Event/projection flow

```
canonical events → handleStreamEvent → setMessages (existing) +
  bounded activity feed (200) + touched-file derivation (100)
→ surfaces render props
```

Surfaces import only React + prop types: no service, SDK, Electron, or Node
imports (verified by test). No `ai-core/src/workspace.ts` — layout state is
not a domain contract.

## Chat integration

`ChatSurface` is the verbatim PR16–PR28 conversation UI (bubbles, permission
banner, error banner). Streaming, model selection, cancellation unchanged.
Subscription effect deps corrected to `[conversationId, handleStreamEvent]` —
model selection no longer tears down the event subscription.

## Coding integration

`CodingSurface` is the verbatim PR30 coding UI (project/prompt inputs, task +
node checklist, cancel). Tasks continue across surface switches because
switching is store-only; the runtime is untouched.

## TaskGraph integration

`TasksSurface` renders agent + coding tasks with node checklists from the
existing `getTaskGraph` IPC payloads. Selection sets `activeTaskId`; the
inspector derives the same task object from backend lists. No second task
state machine.

## Project isolation

Enforced at three layers: backend (PR28/PR30 project scoping, path policy),
store (project switch clears task selection), and view (sidebar project
input + inspector project label). Proven by reducer test + E2E.

## Accessibility

Semantic buttons/nav, `aria-pressed`/`aria-label` on controls and panels,
focus-visible rings, keyboard-operable resize handles with ARIA
min/max/now, no drag-only interactions, error alerts with `role="alert"`.

## Performance

Surfaces are separate components under one App subscription (no new
subscriptions added); activity/files feeds bounded; resize writes only the
store width (no layout thrash); no giant re-render on each token beyond the
pre-existing message path.

## Non-goals

Plugins, MCP Apps, browser automation, collaboration, cloud sync,
accounts, mobile, IDE replacement, background agents, new model/provider/
runtime/permission architectures, `packages/workspace`, HTTP backend,
new event store, renderer filesystem access.
