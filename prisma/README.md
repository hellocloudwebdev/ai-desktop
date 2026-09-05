# Canonical repository location for the Prisma schema.

The schema, migrations, and generated-client configuration arrive with the storage
implementation (PR8) — see docs/decisions/ADR-006-storage.md. Until then this directory
is intentionally empty: no schema file exists and Prisma is not a dependency of any
package. Only the `storage` package may import Prisma (docs/architecture/CONSTITUTION.md,
rule 2.1).
