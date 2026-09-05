# ADR-001: Electron as the Desktop Shell

- **Status:** Accepted — implementation deferred to PR12
- **Date:** 2026-09-05

## Context

The product is a desktop AI assistant that needs OS integration: native windows, file
system access, process spawning, and a sandboxed UI process. A web-only app cannot provide
this; a fully native toolkit would forgo the web renderer ecosystem.

## Decision

Electron is the application shell. The main process and preload script live exclusively in
`apps/desktop`; no other package may import Electron (CONSTITUTION.md §1.1).

At the time of PR1, the current stable Electron release is **44.0.0**. The exact version is
deliberately **not pinned yet**: PR1 installs no Electron dependency at all. PR12 will pin
the version after verifying compatibility with the surrounding toolchain, rather than
locking a number prematurely.

## Consequences

- Privileged Node.js capability exists only inside `apps/desktop`.
- The renderer is sandboxed and reaches privileged functionality only through preload IPC
  (ADR-005).
- Implementation order is fixed: the shell arrives in PR12, typed IPC in PR13, and later
  integration PRs build on that. PR1–PR11 produce no Electron code.
