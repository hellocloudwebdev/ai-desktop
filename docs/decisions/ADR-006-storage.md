# ADR-006: Storage

- **Status:** Accepted (principles locked) — implementation deferred to PR8
- **Date:** 2026-09-05

## Context

The system needs durable local persistence: the authoritative event stream (ADR-003),
conversation history, and operational metadata.

## Decision

SQLite is the persistence layer, accessed exclusively through Prisma inside the `storage`
package:

- **Never import Prisma outside `storage`** (CONSTITUTION.md §2.1) — the ORM and its
  generated client are implementation details of `storage`.
- **`prisma/` is the canonical repository location** for the schema. It is created as an
  empty directory in PR1 (no schema, no Prisma dependency) so the location is locked
  without prematurely pinning a Prisma version.
- **Secrets are never stored raw in SQLite** (CONSTITUTION.md §5.1) — they are encrypted
  or held outside the database before persistence.
- Persisted events always carry `sequence` and `schemaVersion` (ADR-003).

Schema design, migrations, and the storage API surface are defined in PR8.

## Consequences

- No `@prisma/client` dependency may appear before PR8.
- Every other package persists through `storage`'s abstractions, never the database
  directly.
