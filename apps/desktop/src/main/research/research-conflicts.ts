// PR36: apps/desktop — Deterministic Numeric Conflict Detection
//
// When collected sources disagree on a figure (100M vs 80M users), the run
// records a ResearchConflict instead of silently picking a winner. Detection
// is deliberately narrow — numbers with comparable units — so it never
// hallucinates disagreements. Deterministic: same input, same conflicts,
// sorted by unit.

import { createResearchConflictId, type ResearchConflict } from "@ai-desktop/ai-core";

export interface ConflictDetectionItem {
  readonly evidenceId: string;
  readonly claimId?: string;
  readonly sourceId: string;
  readonly excerpt: string;
}

interface FigureHit {
  readonly value: number;
  readonly unit: string;
  readonly item: ConflictDetectionItem;
}

export const NUMERIC_CONFLICT_UNIT_PATTERN =
  /(?:\$\s*(\d[\d,]*\.?\d*))|(?:(\d[\d,]*\.?\d*)\s*([mMbBkKtT])?\s*(%|percent|millions?|billions?|trillions?|thousands?|users?|usd|dollars?|\$)?)/gi;

function normalizeMagnitude(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  switch (raw.toLowerCase()) {
    case "k":
      return "thousand";
    case "m":
      return "million";
    case "b":
      return "billion";
    case "t":
      return "trillion";
    default:
      return undefined;
  }
}

function normalizeUnit(raw: string | undefined, magnitude: string | undefined): string | undefined {
  const fromMagnitude = normalizeMagnitude(magnitude);
  if (fromMagnitude) {
    return fromMagnitude;
  }
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  if (lower === "$") {
    return "usd";
  }
  if (lower === "%" || lower === "percent") {
    return "percent";
  }
  if (lower === "dollar" || lower === "dollars" || lower === "usd") {
    return "usd";
  }
  if (lower.startsWith("million")) {
    return "million";
  }
  if (lower.startsWith("billion")) {
    return "billion";
  }
  if (lower.startsWith("trillion")) {
    return "trillion";
  }
  if (lower.startsWith("thousand")) {
    return "thousand";
  }
  if (lower.startsWith("user")) {
    return "users";
  }
  return lower;
}

function normalizeNumber(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, ""));
}

function trimExcerpt(excerpt: string): string {
  const trimmed = excerpt.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

export function createResearchConflict(
  topic: string,
  sideA: { text: string; claimIds: string[]; evidenceIds: string[]; sourceIds: string[] },
  sideB: { text: string; claimIds: string[]; evidenceIds: string[]; sourceIds: string[] },
): ResearchConflict {
  return {
    conflictId: createResearchConflictId(),
    topic,
    claimA: {
      text: sideA.text,
      claimIds: sideA.claimIds.map((id) => id as never),
      evidenceIds: sideA.evidenceIds.map((id) => id as never),
      sourceIds: sideA.sourceIds as never,
    },
    claimB: {
      text: sideB.text,
      claimIds: sideB.claimIds.map((id) => id as never),
      evidenceIds: sideB.evidenceIds.map((id) => id as never),
      sourceIds: sideB.sourceIds as never,
    },
  };
}

export function detectNumericConflicts(
  items: readonly ConflictDetectionItem[],
): ResearchConflict[] {
  const byUnit = new Map<string, FigureHit[]>();
  for (const item of items) {
    NUMERIC_CONFLICT_UNIT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_CONFLICT_UNIT_PATTERN.exec(item.excerpt)) !== null) {
      if (match[0].length === 0) {
        NUMERIC_CONFLICT_UNIT_PATTERN.lastIndex += 1;
        continue;
      }
      // Group 1: prefix-$ form ("$20"). Groups 2-4: number-first form.
      const rawNumber = (match[1] ?? match[2] ?? "") as string;
      const value = normalizeNumber(rawNumber);
      if (!Number.isFinite(value)) {
        continue;
      }
      let unit: string | undefined;
      if (match[1] !== undefined) {
        unit = "usd";
      } else {
        unit = normalizeUnit(match[4] as string | undefined, match[3] as string | undefined);
      }
      if (!unit) {
        continue;
      }
      const list = byUnit.get(unit);
      const hit: FigureHit = { value, unit, item };
      if (list) {
        list.push(hit);
      } else {
        byUnit.set(unit, [hit]);
      }
    }
  }
  const conflicts: ResearchConflict[] = [];
  for (const unit of [...byUnit.keys()].sort()) {
    const hits = (byUnit.get(unit) ?? []).filter((h) => h.item.sourceId);
    const values = new Set(hits.map((h) => h.value));
    const sources = new Set(hits.map((h) => h.item.sourceId));
    if (values.size < 2 || sources.size < 2) {
      continue;
    }
    const distinct = [...values].sort((a, b) => a - b).slice(0, 2);
    const sideFor = (value: number): FigureHit[] => hits.filter((h) => h.value === value);
    const sideA = sideFor(distinct[0] as number);
    const sideB = sideFor(distinct[1] as number);
    const firstA = sideA[0] as FigureHit;
    const firstB = sideB[0] as FigureHit;
    conflicts.push(
      createResearchConflict(
        `Conflicting figures (${unit})`,
        {
          text: trimExcerpt(firstA.item.excerpt),
          claimIds: sideA.map((h) => h.item.claimId ?? h.item.evidenceId),
          evidenceIds: sideA.map((h) => h.item.evidenceId),
          sourceIds: [...new Set(sideA.map((h) => h.item.sourceId))],
        },
        {
          text: trimExcerpt(firstB.item.excerpt),
          claimIds: sideB.map((h) => h.item.claimId ?? h.item.evidenceId),
          evidenceIds: sideB.map((h) => h.item.evidenceId),
          sourceIds: [...new Set(sideB.map((h) => h.item.sourceId))],
        },
      ),
    );
  }
  return conflicts;
}
