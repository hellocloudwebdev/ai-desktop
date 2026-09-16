// PR41: apps/desktop — Diagnostics Service (in-memory store, no daemon)
//
// A plain in-memory store for per-project diagnostics reported by task
// output adapters (wired in a later PR). This file owns storage only:
// validation, per project+source caps, merged sorted listing, scoped clear.
// No filesystem access, no execution, no EventBus, no background polling.
//
// Invariants:
//   1. Malformed entries produce typed WorkspaceError results; the store
//      never throws raw and never stores partial reports.
//   2. Caps are deterministic: at most DIAGNOSTICS_MAX_PER_SOURCE entries
//      per project+source; overflow evicts oldest first and reports it.
//   3. list() merges all sources sorted by (severity rank, path, line,
//      column); an optional path prefix scopes the merge.
//   4. clear() without a source removes every source for the project.

import { WorkspaceError } from "./workspace-errors.js";

export const DIAGNOSTICS_MAX_PER_SOURCE = 500;

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

function isSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning" || value === "information" || value === "hint";
}

export interface DiagnosticInput {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly code?: string;
}

export interface StoredDiagnostic extends DiagnosticInput {
  readonly source: string;
  readonly sequence: number;
}

export interface ReportInput {
  readonly projectId: string;
  readonly source: string;
  readonly diagnostics: readonly DiagnosticInput[];
}

export interface ReportOutcome {
  readonly stored: number;
  readonly evicted: number;
  readonly totalForSource: number;
}

export interface ListDiagnosticsInput {
  readonly projectId: string;
  readonly path?: string;
}

export interface ClearDiagnosticsInput {
  readonly projectId: string;
  readonly source?: string;
}

function validateEntry(
  projectId: string,
  source: string,
  entry: DiagnosticInput,
  index: number,
): void {
  const where = `diagnostics[${index}]`;
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": path must be non-empty`,
    );
  }
  if (!Number.isInteger(entry.line) || entry.line < 1) {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": line must be >= 1`,
    );
  }
  if (!Number.isInteger(entry.column) || entry.column < 1) {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": column must be >= 1`,
    );
  }
  if (!isSeverity(entry.severity)) {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": severity must be error|warning|information|hint`,
    );
  }
  if (typeof entry.message !== "string" || entry.message.length === 0) {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": message must be non-empty`,
    );
  }
  if (entry.code !== undefined && typeof entry.code !== "string") {
    throw new WorkspaceError(
      "INVALID",
      `Malformed diagnostic ${where} for project "${projectId}" source "${source}": code must be a string`,
    );
  }
}

export class DiagnosticsService {
  private readonly _store = new Map<string, Map<string, StoredDiagnostic[]>>();
  private _sequence = 0;

  report(input: ReportInput): ReportOutcome {
    if (typeof input.projectId !== "string" || input.projectId.length === 0) {
      throw new WorkspaceError("INVALID", "projectId must be a non-empty string");
    }
    if (typeof input.source !== "string" || input.source.length === 0) {
      throw new WorkspaceError("INVALID", "source must be a non-empty string");
    }
    if (!Array.isArray(input.diagnostics)) {
      throw new WorkspaceError("INVALID", "diagnostics must be an array");
    }
    input.diagnostics.forEach((entry, index) =>
      validateEntry(input.projectId, input.source, entry, index),
    );

    let bySource = this._store.get(input.projectId);
    if (!bySource) {
      bySource = new Map<string, StoredDiagnostic[]>();
      this._store.set(input.projectId, bySource);
    }
    const stored: StoredDiagnostic[] = input.diagnostics.map((entry) => {
      this._sequence += 1;
      const record: StoredDiagnostic = {
        path: entry.path,
        line: entry.line,
        column: entry.column,
        severity: entry.severity,
        message: entry.message,
        source: input.source,
        sequence: this._sequence,
        ...(entry.code !== undefined ? { code: entry.code } : {}),
      };
      return record;
    });
    bySource.set(input.source, stored);
    let evicted = 0;
    if (stored.length > DIAGNOSTICS_MAX_PER_SOURCE) {
      evicted = stored.length - DIAGNOSTICS_MAX_PER_SOURCE;
      bySource.set(input.source, stored.slice(evicted));
    }
    const totalForSource = bySource.get(input.source)?.length ?? 0;
    return { stored: stored.length, evicted, totalForSource };
  }

  list(input: ListDiagnosticsInput): StoredDiagnostic[] {
    const bySource = this._store.get(input.projectId);
    if (!bySource) return [];
    const merged: StoredDiagnostic[] = [];
    for (const records of bySource.values()) {
      for (const record of records) {
        if (input.path !== undefined && !isUnderPath(record.path, input.path)) continue;
        merged.push(record);
      }
    }
    merged.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.line - b.line ||
        a.column - b.column ||
        a.sequence - b.sequence,
    );
    return merged;
  }

  clear(input: ClearDiagnosticsInput): { cleared: number } {
    const bySource = this._store.get(input.projectId);
    if (!bySource) return { cleared: 0 };
    if (input.source === undefined) {
      let cleared = 0;
      for (const records of bySource.values()) cleared += records.length;
      this._store.delete(input.projectId);
      return { cleared };
    }
    const records = bySource.get(input.source);
    if (!records) return { cleared: 0 };
    bySource.delete(input.source);
    if (bySource.size === 0) this._store.delete(input.projectId);
    return { cleared: records.length };
  }

  count(projectId: string): number {
    const bySource = this._store.get(projectId);
    if (!bySource) return 0;
    let total = 0;
    for (const records of bySource.values()) total += records.length;
    return total;
  }
}

function isUnderPath(recordPath: string, scope: string): boolean {
  if (scope === "." || scope === "") return true;
  const normalized = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return recordPath === normalized || recordPath.startsWith(`${normalized}/`);
}
