// PR35: apps/desktop — Provider Health & Provenance Builder
//
// Host-side provider health ledger (available / unavailable / degraded /
// authRequired) plus the single provenance-construction helper so every
// adapter records attempted providers and the successful provider.

import { now, type Timestamp } from "@ai-desktop/shared";
import type {
  ResearchChannel,
  ResearchProvenance,
  ResearchProviderStatus,
} from "@ai-desktop/ai-core";

export interface ProviderHealthSnapshot {
  readonly provider: string;
  readonly status: ResearchProviderStatus;
  readonly consecutiveFailures: number;
  readonly lastCheckedAt?: Timestamp;
  readonly lastError?: string;
}

const FAILURE_THRESHOLD = 3;

export class ResearchProviderHealth {
  private readonly _states = new Map<
    string,
    {
      failures: number;
      status: ResearchProviderStatus;
      lastCheckedAt?: Timestamp;
      lastError?: string;
    }
  >();

  getStatus(provider: string): ResearchProviderStatus {
    return this._states.get(provider)?.status ?? "available";
  }

  reportSuccess(provider: string): void {
    this._states.set(provider, {
      failures: 0,
      status: "available",
      lastCheckedAt: now(),
    });
  }

  reportFailure(provider: string, error?: string, authRequired = false): void {
    const prev = this._states.get(provider);
    const failures = (prev?.failures ?? 0) + 1;
    this._states.set(provider, {
      failures,
      status: authRequired
        ? "authRequired"
        : failures >= FAILURE_THRESHOLD
          ? "unavailable"
          : "degraded",
      lastCheckedAt: now(),
      ...(error ? { lastError: error.slice(0, 500) } : {}),
    });
  }

  snapshot(): ProviderHealthSnapshot[] {
    return [...this._states.entries()].map(([provider, state]) => ({
      provider,
      status: state.status,
      consecutiveFailures: state.failures,
      ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    }));
  }
}

export interface ProvenanceInput {
  readonly provider: string;
  readonly channel: ResearchChannel;
  readonly sourceUrl?: string;
  readonly retrievedAt?: Timestamp;
  readonly publishedAt?: Timestamp;
  readonly attemptedProviders?: readonly string[];
  readonly cached?: boolean;
}

export function buildProvenance(input: ProvenanceInput): ResearchProvenance {
  const attempted = input.attemptedProviders?.length
    ? [...input.attemptedProviders]
    : [input.provider];
  if (!attempted.includes(input.provider)) {
    attempted.push(input.provider);
  }
  return {
    provider: input.provider,
    channel: input.channel,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    retrievedAt: input.retrievedAt ?? now(),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    attemptedProviders: attempted,
    successfulProvider: input.provider,
    cached: input.cached ?? false,
  };
}
