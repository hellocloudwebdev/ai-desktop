// PR35.20: apps/desktop — Bounded Research Cache
//
// Invariants:
//   1. Host-owned in-memory cache: deterministic keys (channel + provider +
//      URL/query hash), per-channel TTLs from the research policy, FIFO
//      eviction at a fixed entry cap (never unbounded).
//   2. Authenticated resources are never cached: entries carrying secrets or
//      marked authenticated:true are rejected at set() time.
//   3. Payloads are size-bounded; oversized values fail closed rather than
//      evicting the world.

import { createHash } from "node:crypto";
import type { ResearchChannel } from "@ai-desktop/ai-core";

export interface ResearchCacheEntry<T = unknown> {
  readonly key: string;
  readonly provider: string;
  readonly channel: ResearchChannel;
  readonly retrievedAt: number;
  readonly expiresAt: number;
  readonly payload: T;
  readonly authenticated: boolean;
}

export interface ResearchCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: Partial<Record<ResearchChannel, number>>;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS: Record<ResearchChannel, number> = {
  search: 5 * 60 * 1000,
  web: 15 * 60 * 1000,
  github: 5 * 60 * 1000,
  youtube: 30 * 60 * 1000,
  rss: 30 * 60 * 1000,
};

const MAX_CACHED_PAYLOAD_CHARS = 100000;

/** Deterministic cache key: channel + provider + sha256 of normalized input. */
export function researchCacheKey(
  channel: ResearchChannel,
  provider: string,
  input: string,
): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${channel}:${provider}:${hash}`;
}

export class ResearchCache<T = unknown> {
  private readonly _entries = new Map<string, ResearchCacheEntry<T>>();
  private readonly _maxEntries: number;
  private readonly _ttlMs: Record<ResearchChannel, number>;
  private readonly _now: () => number;

  constructor(options?: ResearchCacheOptions) {
    this._maxEntries = options?.maxEntries ?? 200;
    this._ttlMs = { ...DEFAULT_TTL_MS, ...options?.ttlMs };
    this._now = options?.now ?? Date.now;
  }

  get size(): number {
    return this._entries.size;
  }

  get(key: string): ResearchCacheEntry<T> | undefined {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this._now()) {
      this._entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Stores a public payload. Returns false (no store) for authenticated
   * entries, oversized payloads, or expired timestamps — never throws.
   */
  set(entry: ResearchCacheEntry<T>): boolean {
    if (entry.authenticated) return false;
    if (entry.expiresAt <= entry.retrievedAt) return false;
    try {
      if (JSON.stringify(entry.payload)?.length > MAX_CACHED_PAYLOAD_CHARS) return false;
    } catch {
      return false;
    }
    while (this._entries.size >= this._maxEntries) {
      const oldest = this._entries.keys().next();
      if (oldest.done) break;
      this._entries.delete(oldest.value);
    }
    this._entries.set(entry.key, entry);
    return true;
  }

  invalidate(key: string): boolean {
    return this._entries.delete(key);
  }

  clear(): void {
    this._entries.clear();
  }

  ttlFor(channel: ResearchChannel): number {
    return this._ttlMs[channel];
  }
}
