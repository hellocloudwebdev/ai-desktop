// PR36: apps/desktop — Research Citations + Integrity Verification
//
// Citations are structured references to actually-collected sources: one
// citation per source that contributed evidence. verifyCitationIntegrity
// proves the claim -> evidence -> source chain has no dangling references.

import {
  createResearchCitationId,
  type ResearchCanonicalSource,
  type ResearchCitation,
  type ResearchClaim,
  type ResearchEvidence,
} from "@ai-desktop/ai-core";

export function buildResearchCitations(
  sources: readonly ResearchCanonicalSource[],
  evidence: readonly ResearchEvidence[],
): ResearchCitation[] {
  const bySource = new Map<string, ResearchEvidence[]>();
  for (const item of evidence) {
    const list = bySource.get(item.sourceId);
    if (list) {
      list.push(item);
    } else {
      bySource.set(item.sourceId, [item]);
    }
  }
  const citations: ResearchCitation[] = [];
  for (const source of sources) {
    const sourceEvidence = bySource.get(source.sourceId);
    if (!sourceEvidence || sourceEvidence.length === 0) {
      continue;
    }
    const first = sourceEvidence[0] as ResearchEvidence;
    citations.push({
      citationId: createResearchCitationId(),
      sourceId: source.sourceId,
      ...(source.title ? { title: source.title } : {}),
      url: source.canonicalUrl,
      ...(source.publisher ? { publisher: source.publisher } : {}),
      ...(source.domain ? { domain: source.domain } : {}),
      retrievedAt: source.lastRetrievedAt,
      ...(first.locator ? { locator: first.locator } : {}),
    });
  }
  return citations;
}

export interface CitationIntegrityReport {
  readonly ok: boolean;
  readonly danglingCitationSourceIds: string[];
  readonly danglingEvidenceSourceIds: string[];
  readonly danglingClaimEvidenceIds: string[];
  readonly danglingClaimSourceIds: string[];
}

export function verifyCitationIntegrity(input: {
  readonly sources: readonly ResearchCanonicalSource[];
  readonly evidence: readonly ResearchEvidence[];
  readonly claims: readonly ResearchClaim[];
  readonly citations: readonly ResearchCitation[];
}): CitationIntegrityReport {
  const sourceIds = new Set(input.sources.map((s) => s.sourceId));
  const evidenceIds = new Set(input.evidence.map((e) => e.evidenceId));
  const danglingCitationSourceIds = [
    ...new Set(input.citations.filter((c) => !sourceIds.has(c.sourceId)).map((c) => c.sourceId)),
  ];
  const danglingEvidenceSourceIds = [
    ...new Set(input.evidence.filter((e) => !sourceIds.has(e.sourceId)).map((e) => e.sourceId)),
  ];
  const danglingClaimEvidenceIds = [
    ...new Set(input.claims.flatMap((c) => c.evidenceIds.filter((id) => !evidenceIds.has(id)))),
  ];
  const danglingClaimSourceIds = [
    ...new Set(input.claims.flatMap((c) => c.sourceIds.filter((id) => !sourceIds.has(id)))),
  ];
  return {
    ok:
      danglingCitationSourceIds.length === 0 &&
      danglingEvidenceSourceIds.length === 0 &&
      danglingClaimEvidenceIds.length === 0 &&
      danglingClaimSourceIds.length === 0,
    danglingCitationSourceIds,
    danglingEvidenceSourceIds,
    danglingClaimEvidenceIds,
    danglingClaimSourceIds,
  };
}
