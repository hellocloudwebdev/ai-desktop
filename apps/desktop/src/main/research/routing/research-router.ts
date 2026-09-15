// PR35.11/35.22: apps/desktop — Research Router (controlled fallback)
//
// Invariants:
//   1. Explicit channel -> adapter registration: primary first, zero or more
//      ordered fallbacks. Backend selection is host configuration, never
//      model input.
//   2. Fallback is never silent: every outcome reports attemptedProviders in
//      order and the successful provider. A failed primary without a viable
//      fallback surfaces the primary error, not an unrelated source.
//   3. Cancellation aborts the in-flight adapter and stops the chain (no
//      detached work). Auth errors (ResearchAuthRequired) never fall through
//      to an unrelated backend — credentials for A must not silently become
//      reads from B.

import type { ResearchChannel, ResearchProviderStatus } from "@ai-desktop/ai-core";
import { ResearchAuthRequired, toCanonicalResearchError } from "../research-errors.js";

export interface ResearchAdapterLike {
  readonly provider: string;
  health(): Promise<ResearchProviderStatus>;
}

export interface RoutedAttempt<T> {
  readonly outcome: T;
  readonly provider: string;
  readonly attemptedProviders: string[];
}

export interface ResearchRouterDeps {
  readonly channels?: Partial<Record<ResearchChannel, ResearchAdapterLike[]>>;
}

export class ResearchRouter {
  private readonly _channels = new Map<ResearchChannel, ResearchAdapterLike[]>();

  constructor(deps?: ResearchRouterDeps) {
    if (deps?.channels) {
      for (const [channel, adapters] of Object.entries(deps.channels)) {
        this._channels.set(channel as ResearchChannel, [...(adapters ?? [])]);
      }
    }
  }

  register(channel: ResearchChannel, adapter: ResearchAdapterLike): void {
    const list = this._channels.get(channel) ?? [];
    if (!list.some((a) => a.provider === adapter.provider)) {
      list.push(adapter);
    }
    this._channels.set(channel, list);
  }

  adaptersFor(channel: ResearchChannel): readonly ResearchAdapterLike[] {
    return this._channels.get(channel) ?? [];
  }

  providerStatus(channel: ResearchChannel): readonly { provider: string }[] {
    return this.adaptersFor(channel).map((a) => ({ provider: a.provider }));
  }

  async providerHealth(channel: ResearchChannel): Promise<Record<string, ResearchProviderStatus>> {
    const health: Record<string, ResearchProviderStatus> = {};
    for (const adapter of this.adaptersFor(channel)) {
      try {
        health[adapter.provider] = await adapter.health();
      } catch {
        health[adapter.provider] = "unavailable";
      }
    }
    return health;
  }

  /**
   * Runs the primary then fallbacks in order. run(adapter, attempted) binds
   * the concrete operation. Auth failures stop the chain; aborts stop the
   * chain; other failures continue to the next registered adapter.
   */
  async route<T>(
    channel: ResearchChannel,
    run: (adapter: ResearchAdapterLike, attempted: string[]) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<RoutedAttempt<T>> {
    const adapters = this.adaptersFor(channel);
    if (adapters.length === 0) {
      throw new Error(`No research adapters registered for channel "${channel}"`);
    }
    const attempted: string[] = [];
    let lastError: unknown = undefined;
    for (const adapter of adapters) {
      if (options?.signal?.aborted) {
        throw Object.assign(new Error("Research operation cancelled"), { name: "AbortError" });
      }
      attempted.push(adapter.provider);
      try {
        const outcome = await run(adapter, [...attempted]);
        return { outcome, provider: adapter.provider, attemptedProviders: [...attempted] };
      } catch (err: unknown) {
        if (err instanceof ResearchAuthRequired) {
          throw err;
        }
        const name = err instanceof Error ? err.name : "";
        const message = err instanceof Error ? err.message : String(err);
        if (name === "AbortError" || /\b(aborted|cancelled|canceled)\b/i.test(message)) {
          throw err;
        }
        lastError = err;
      }
    }
    throw toCanonicalResearchError(lastError);
  }
}
