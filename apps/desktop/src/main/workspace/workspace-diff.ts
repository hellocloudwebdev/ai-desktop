// PR41: apps/desktop — Workspace Diff (pure, zero-dependency)
//
// Deterministic unified-diff computation for before/after text snapshots.
// Pure functions only: no filesystem, no execution, no IPC. The LCS dynamic
// program is cell-capped so pathological inputs truncate instead of blowing
// memory; context lines are fixed at 3 per hunk.

export const DIFF_CONTEXT_LINES = 3;
export const DIFF_MAX_CELLS = 1_000_000;

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: DiffLine[];
}

export interface UnifiedDiff {
  readonly path?: string;
  readonly hunks: DiffHunk[];
  readonly truncated: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/**
 * Line-level diff via LCS with a cell-count cap. Returns the edit script as
 * a sequence of context/add/del lines, or truncated:true when the DP table
 * would exceed DIFF_MAX_CELLS (callers still get a prefix hunk so the
 * result shape is stable).
 */
export function diffLines(a: string, b: string): { lines: DiffLine[]; truncated: boolean } {
  const oldLines = splitLines(a);
  const newLines = splitLines(b);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > DIFF_MAX_CELLS) {
    const prefix = Math.min(n, m, 500);
    const lines: DiffLine[] = [];
    for (let i = 0; i < prefix; i++) {
      lines.push({ kind: "context", text: oldLines[i] ?? "" });
    }
    for (let i = prefix; i < n; i++) {
      lines.push({ kind: "del", text: oldLines[i] ?? "" });
    }
    for (let i = prefix; i < m; i++) {
      lines.push({ kind: "add", text: newLines[i] ?? "" });
    }
    return { lines, truncated: true };
  }

  // LCS suffix lengths: table[i][j] = LCS(old[i..], new[j..]).
  // Capped at DIFF_MAX_CELLS entries (~8 MB worst case), well bounded.
  const table: number[][] = [];
  for (let i = n; i >= 0; i--) {
    table[i] = new Array<number>(m + 1).fill(0);
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i];
    const next = table[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        row[j] = (next[j + 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }

  const lengthAt = (i: number, j: number): number => {
    if (i >= n || j >= m) return 0;
    return table[i]?.[j] ?? 0;
  };

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i] ?? "" });
      i += 1;
      j += 1;
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      lines.push({ kind: "del", text: oldLines[i] ?? "" });
      i += 1;
    } else {
      lines.push({ kind: "add", text: newLines[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: oldLines[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    lines.push({ kind: "add", text: newLines[j] ?? "" });
    j += 1;
  }
  return { lines, truncated: false };
}

/**
 * Groups an edit script into hunks with DIFF_CONTEXT_LINES of context.
 * Adjacent change blocks whose context gap fits in one window merge.
 */
export function computeUnifiedDiff(oldText: string, newText: string, path?: string): UnifiedDiff {
  const { lines, truncated } = diffLines(oldText, newText);
  const hunks: DiffHunk[] = [];
  const changedAt: boolean[] = lines.map((l) => l.kind !== "context");
  let i = 0;
  const total = lines.length;
  while (i < total) {
    if (!changedAt[i]) {
      i += 1;
      continue;
    }
    // Include leading context.
    const start = Math.max(0, i - DIFF_CONTEXT_LINES);
    // Extend through trailing runs while the context gap stays mergeable.
    let end = i;
    let lastChange = i;
    for (let k = i; k < total; k++) {
      if (changedAt[k]) lastChange = k;
      // A gap of more than 2*context context lines starts a new hunk.
      if (k - lastChange > DIFF_CONTEXT_LINES * 2) break;
      end = k;
    }
    end = Math.min(total - 1, lastChange + DIFF_CONTEXT_LINES);
    const hunkLines = lines.slice(start, end + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const l of hunkLines) {
      if (l.kind !== "add") oldCount += 1;
      if (l.kind !== "del") newCount += 1;
    }
    // Compute 1-based starts by counting consumed lines before the hunk.
    let oldBefore = 0;
    let newBefore = 0;
    for (let k = 0; k < start; k++) {
      const l = lines[k];
      if (!l) continue;
      if (l.kind !== "add") oldBefore += 1;
      if (l.kind !== "del") newBefore += 1;
    }
    hunks.push({
      oldStart: oldBefore + 1,
      oldLines: oldCount,
      newStart: newBefore + 1,
      newLines: newCount,
      lines: hunkLines,
    });
    i = end + 1;
  }
  return { ...(path !== undefined ? { path } : {}), hunks, truncated };
}

/**
 * Renders hunks in unified format (@@ -a,b +c,d @@ headers, space/+/-
 * prefixes). Deterministic for identical input; no timestamps emitted.
 */
export function toUnifiedString(diff: UnifiedDiff, path?: string): string {
  const label = path ?? diff.path ?? "file";
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const hunk of diff.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
    }
  }
  return out.join("\n");
}
