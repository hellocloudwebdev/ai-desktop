# ADR-002: Monorepo with pnpm Workspaces and Turborepo

- **Status:** Accepted — implemented in PR1
- **Date:** 2026-09-05

## Context

The system decomposes into a dozen packages with a locked dependency graph
(`dependency-graph.md`) plus one desktop application. They must version, build, and evolve
together, with one source of truth for boundaries and tooling.

## Decision

A single repository using **pnpm workspaces** (`apps/*`, `packages/*`) with **Turborepo**
for task orchestration. Package scope: `@ai-desktop/*`. `prisma/` is a repository directory,
not a workspace package.

Pinned at PR1: Turbo `2.10.12`, TypeScript `5.9.3`, Prettier `3.9.6`, ESLint `^10.10.0` with
`typescript-eslint` `^8.69.0` (verified compatible with TypeScript 5.9). TypeScript 7 is
known to exist and is deliberately not adopted without a compatibility verification pass.

## Consequences

- One lockfile; CI installs, typechecks, lints, tests, and builds through Turbo.
- PR1 keeps the Turbo task graph to the five foundation tasks only; per-domain
  orchestration tasks are added by the PRs that need them.
- PR2 adds mechanical enforcement of the dependency graph on top of this foundation.
