// PR36: apps/desktop — Research Budgets + Bounded Parallelism
//
// Every research run is bounded: each counter increment is enforced before
// work proceeds, so a runaway query fan-out degrades to a partial package
// instead of exhausting memory. Cancellation propagates through AbortSignal
// to every outstanding child operation.

import type { ResearchLimits } from "@ai-desktop/ai-core";
import { ResearchBudgetExceeded, ResearchCancelled } from "./research-errors.js";

export interface ResearchBudgetSnapshot {
  readonly searches: number;
  readonly sources: number;
  readonly pages: number;
  readonly bytes: number;
  readonly chars: number;
  readonly elapsedMs: number;
}

export class ResearchBudgetTracker {
  private readonly _limits: ResearchLimits;
  private readonly _startedAt: number;
  private _searches = 0;
  private _sources = 0;
  private _pages = 0;
  private _bytes = 0;
  private _chars = 0;

  constructor(limits: ResearchLimits, opts?: { startedAt?: number }) {
    this._limits = limits;
    this._startedAt = opts?.startedAt ?? Date.now();
  }

  private _checkDuration(): void {
    if (Date.now() - this._startedAt > this._limits.maxDurationMs) {
      throw new ResearchBudgetExceeded("maxDurationMs");
    }
  }

  checkSearch(): void {
    this._checkDuration();
    this._searches += 1;
    if (this._searches > this._limits.maxSearches) {
      throw new ResearchBudgetExceeded("maxSearches");
    }
  }

  checkSource(): void {
    this._checkDuration();
    this._sources += 1;
    if (this._sources > this._limits.maxSources) {
      throw new ResearchBudgetExceeded("maxSources");
    }
  }

  checkPage(bytes: number, chars: number): void {
    this._checkDuration();
    this._pages += 1;
    if (this._pages > this._limits.maxPages) {
      throw new ResearchBudgetExceeded("maxPages");
    }
    this._bytes += Math.max(0, bytes);
    if (this._bytes > this._limits.maxBytes) {
      throw new ResearchBudgetExceeded("maxBytes");
    }
    this._chars += Math.max(0, chars);
    if (this._chars > this._limits.maxCharacters) {
      throw new ResearchBudgetExceeded("maxCharacters");
    }
  }

  snapshot(): ResearchBudgetSnapshot {
    return {
      searches: this._searches,
      sources: this._sources,
      pages: this._pages,
      bytes: this._bytes,
      chars: this._chars,
      elapsedMs: Date.now() - this._startedAt,
    };
  }

  isExhausted(): boolean {
    const snap = this.snapshot();
    return (
      snap.searches >= this._limits.maxSearches ||
      snap.sources >= this._limits.maxSources ||
      snap.pages >= this._limits.maxPages ||
      snap.bytes >= this._limits.maxBytes ||
      snap.chars >= this._limits.maxCharacters ||
      snap.elapsedMs >= this._limits.maxDurationMs
    );
  }
}

/**
 * Run async work with bounded concurrency, preserving input order.
 * An aborted signal stops launching new work and rejects with
 * ResearchCancelled.
 */
export async function limitParallelism<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  const fail = (err: unknown): void => {
    failed ??= err;
  };

  async function worker(): Promise<void> {
    while (true) {
      if (failed !== undefined) {
        return;
      }
      if (signal?.aborted) {
        fail(new ResearchCancelled());
        return;
      }
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await fn(items[index] as T, index, signal);
      } catch (err) {
        fail(err);
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed !== undefined) {
    throw failed;
  }
  if (signal?.aborted) {
    throw new ResearchCancelled();
  }
  return results;
}
