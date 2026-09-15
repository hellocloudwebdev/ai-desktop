// PR35.5: apps/desktop — Research Provenance Builder
//
// Invariants:
//   1. Every ResearchResult/Source carries full provenance: successful
//      provider, attempted fallback trail, channel, URL, retrieved/published
//      timestamps. Fallback is never silent.
//   2. Timestamps are ISO-8601 UTC strings (shared Timestamp), minted once
//      per retrieval and shared across the source + provenance pair.

import {
  createResearchResultId,
  createResearchSourceId,
  type ResearchChannel,
  type ResearchProvenance,
  type ResearchSource,
} from "@ai-desktop/ai-core";
import { now } from "@ai-desktop/shared";

export interface ProvenanceInput {
  readonly provider: string;
  readonly attemptedProviders?: readonly string[];
  readonly channel: ResearchChannel;
  readonly url?: string;
  readonly publishedAt?: string;
  readonly title?: string;
  readonly contentType?: string;
}

/** Builds a source + provenance pair sharing one retrieval timestamp. */
export function buildResearchSource(input: ProvenanceInput): {
  source: ResearchSource;
  provenance: ResearchProvenance;
  retrievedAt: string;
} {
  const retrievedAt = now();
  const attempted = input.attemptedProviders ?? [input.provider];
  const provenance: ResearchProvenance = {
    provider: input.provider,
    attemptedProviders: [...attempted],
    channel: input.channel,
    ...(input.url ? { url: input.url } : {}),
    retrievedAt,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
  };
  const source: ResearchSource = {
    id: createResearchSourceId(),
    channel: input.channel,
    provider: input.provider,
    ...(input.url ? { url: input.url } : {}),
    ...(input.title ? { title: input.title } : {}),
    retrievedAt,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    provenance,
  };
  return { source, provenance, retrievedAt };
}

/** Generates a fresh ResearchResultId for adapter-built results. */
export function newResearchResultId() {
  return createResearchResultId();
}
