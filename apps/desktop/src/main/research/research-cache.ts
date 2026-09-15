// PR35: apps/desktop — Bounded Research Cache
//
// In-memory LRU cache with per-channel TTLs. Keys are SHA-256 hashes of
// normalized request parameters. Payloads are bounded JSON-serializable
// values; credentials and private resources are never cached.

import crypto from "node:crypto";
import type { ResearchChannel } from "@ai-desktop/ai-core";
import { MAX_RESEARCH_CACHE_ENTRIES, RESEARCH_CACHE_TTL_MS } from "@ai-desktop/ai-core";

export interface CacheEntry<T> {
  readonly key: string;
  readonly channel: ResearchChannel;
  readonly provider: string;
  readonly retrievedAt: number;
  readonly expiresAt: number;
  readonly payload: T;
}

export interface ResearchCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: Partial<Record<ResearchChannel, number>>;
  readonly now?: () => number;
}

export function buildResearchCacheKey(parts: Record<string, unknown>): string {
  const normalized = JSON.stringify(sortKeys(parts));
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export class ResearchCache<T = unknown> {
  private readonly _entries = new Map<string, CacheEntry<T>>();
  private readonly _maxEntries: number;
  private readonly _ttlMs: Record<ResearchChannel, number>;
  private readonly _now: () => number;
  private _hits = 0;
  private _misses = 0;

  constructor(options: ResearchCacheOptions = {}) {
    this._maxEntries = options.maxEntries ?? MAX_RESEARCH_CACHE_ENTRIES;
    this._ttlMs = { ...RESEARCH_CACHE_TTL_MS, ...(options.ttlMs ?? {}) };
    this._now = options.now ?? Date.now;
  }

  get size(): number {
    return this._entries.size;
  }

  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this._entries.get(key);
    if (!entry) {
      this._misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this._now()) {
      this._entries.delete(key);
      this._misses += 1;
      return undefined;
    }
    // LRU refresh.
    this._entries.delete(key);
    this._entries.set(key, entry);
    this._hits += 1;
    return entry;
  }

  set(
    key: string,
    channel: ResearchChannel,
    provider: string,
    payload: T,
    retrievedAt?: number,
  ): CacheEntry<T> {
    const now = retrievedAt ?? this._now();
    const entry: CacheEntry<T> = {
      key,
      channel,
      provider,
      retrievedAt: now,
      expiresAt: now + this._ttlMs[channel],
      payload,
    };
    this._entries.delete(key);
    this._entries.set(key, entry);
    while (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next();
      if (oldest.done) {
        break;
      }
      this._entries.delete(oldest.value);
    }
    return entry;
  }

  invalidate(key: string): boolean {
    return this._entries.delete(key);
  }

  clear(): void {
    this._entries.clear();
  }

  prune(): number {
    const now = this._now();
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt <= now) {
        this._entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
