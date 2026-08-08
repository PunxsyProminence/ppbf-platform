import type { ShadowEvidenceAvailability } from './shadowEvidence';

// Distinct from explainability.confidence (0-100 numeric) and the formula
// engine's ConfidenceState (HIGH/MODERATE/LOW/INSUFFICIENT, data-completeness)
// -- this is a client-facing label for how much verified evidence actually
// backed a given chat response, independent of either of those.
export type ShadowEvidenceTier = 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'RESEARCH_NEEDED';

// The chunk-metadata vocabulary seeded by the PPBF research program
// (apps/web/seed-data/shadow-research/2026-08-07/), verbatim -- these are
// the literal strings stored in pilot.shadow_library_chunks.metadata,
// not a paraphrase. Getting one of these wrong silently drops every row
// carrying it into the 'else' branch of deriveEvidenceTier.
export type ShadowEvidenceClass =
  | 'VERIFIED EVIDENCE'
  | 'STRONG EVIDENCE-SUPPORTED INFERENCE'
  | 'CONTESTED PRACTICE'
  | 'HYPOTHESIS REQUIRING TESTING'
  | 'COACHING/FILM-STUDY INTERPRETATION'
  | 'INSUFFICIENT EVIDENCE';

export type ShadowBoxingSpecificity =
  | 'boxing_specific'
  | 'partly_boxing_specific'
  | 'ppbf_specific'
  | 'transferred';

// 'boxing_specific' and 'ppbf_specific' both count as boxing-specific for
// the PROVEN gate -- ppbf_specific is evidence about THIS gym's own floor,
// which is at least as specific as the sport in general. Verified against
// the real 1,193-chunk corpus: this set produces exactly the distribution
// EVIDENCE_TIER_SPEC.md claims (115 / 796 / 227 / 55), with or without
// ppbf_specific included, because no VERIFIED EVIDENCE + tier<=2 +
// ppbf_specific row exists in the corpus today -- named explicitly rather
// than left as an untested assumption for the day one does.
const BOXING_SPECIFIC_VALUES: ReadonlySet<ShadowBoxingSpecificity> = new Set(['boxing_specific', 'ppbf_specific']);

export interface ShadowEvidenceQuality {
  evidenceClass: ShadowEvidenceClass;
  // Lower = more authoritative (1-5), matching
  // shadow_library_sources.authority_tier and the existing
  // `authority_tier <= minimum_authority_tier` coverage-test convention.
  authorityTier: number;
  boxingSpecificity: ShadowBoxingSpecificity;
}

/**
 * The quality-weighted rule from EVIDENCE_TIER_SPEC.md, replacing the old
 * citation-count rule. The answer-state gate is UNCHANGED -- a degraded,
 * filtered, or queued response still grades RESEARCH_NEEDED regardless of
 * what strongestEvidence carries.
 *
 * strongestEvidence is null when the response cites nothing from the
 * Library (evidence was available in scope but nothing was cited, or the
 * scope itself had none) -- see selectStrongestEvidence below for how a
 * caller reduces a multi-citation response down to this single input.
 *
 * Two invariants worth stating explicitly, because they are the point of
 * the change (verbatim from the spec):
 * 1. PROVEN requires boxing-specific evidence at authority tier 1-2.
 *    Transferred evidence never reaches PROVEN, however much of it there is.
 * 2. A contested claim can never read as PROVEN.
 */
export function deriveEvidenceTier(input: {
  // True only for a genuine, successfully generated answer (state === 'ok').
  // Filtered/degraded/queued responses never had a real evidenced answer to
  // grade, so they always resolve to the lowest tier below.
  isAnsweredState: boolean;
  evidenceAvailability: ShadowEvidenceAvailability;
  strongestEvidence: ShadowEvidenceQuality | null;
}): ShadowEvidenceTier {
  if (!input.isAnsweredState || input.evidenceAvailability === 'unavailable') {
    return 'RESEARCH_NEEDED';
  }

  const evidence = input.strongestEvidence;
  if (!evidence) {
    // Evidence was available in the scope, but this response cited none of
    // it -- the old rule's citationCount===0 case.
    return 'EXPERIMENTAL';
  }

  if (evidence.evidenceClass === 'INSUFFICIENT EVIDENCE') {
    return 'RESEARCH_NEEDED';
  }
  if (
    evidence.evidenceClass === 'CONTESTED PRACTICE'
    || evidence.evidenceClass === 'HYPOTHESIS REQUIRING TESTING'
    || evidence.evidenceClass === 'COACHING/FILM-STUDY INTERPRETATION'
  ) {
    return 'EXPERIMENTAL';
  }
  if (evidence.evidenceClass === 'STRONG EVIDENCE-SUPPORTED INFERENCE') {
    return evidence.authorityTier <= 3 ? 'EMERGING' : 'EXPERIMENTAL';
  }
  // evidence.evidenceClass === 'VERIFIED EVIDENCE'
  if (evidence.authorityTier <= 2 && BOXING_SPECIFIC_VALUES.has(evidence.boxingSpecificity)) {
    return 'PROVEN';
  }
  if (evidence.authorityTier <= 3) {
    return 'EMERGING';
  }
  return 'EXPERIMENTAL';
}

// Rank order for reducing a multi-citation response to the single
// strongest citation deriveEvidenceTier grades on. Higher is stronger.
// This is a DESIGN DECISION the spec's own worked example (one claim, one
// evidence_class/authority_tier/boxing_specificity triple) left open for a
// multi-citation chat response: the BEST evidence actually cited can carry
// the tier, the same way one Cochrane review among three weaker citations
// is still a Cochrane review. It does not mean the response's OTHER
// citations are hidden -- every citation is still shown in Sources; this
// selection only decides what grades the headline tier label.
const EVIDENCE_CLASS_RANK: Record<ShadowEvidenceClass, number> = {
  'VERIFIED EVIDENCE': 4,
  'STRONG EVIDENCE-SUPPORTED INFERENCE': 3,
  'CONTESTED PRACTICE': 2,
  'HYPOTHESIS REQUIRING TESTING': 2,
  'COACHING/FILM-STUDY INTERPRETATION': 2,
  'INSUFFICIENT EVIDENCE': 1,
};

export function selectStrongestEvidence(
  candidates: ShadowEvidenceQuality[],
): ShadowEvidenceQuality | null {
  let strongest: ShadowEvidenceQuality | null = null;
  for (const candidate of candidates) {
    if (!strongest) {
      strongest = candidate;
      continue;
    }
    const candidateRank = EVIDENCE_CLASS_RANK[candidate.evidenceClass];
    const strongestRank = EVIDENCE_CLASS_RANK[strongest.evidenceClass];
    if (
      candidateRank > strongestRank
      || (candidateRank === strongestRank && candidate.authorityTier < strongest.authorityTier)
    ) {
      strongest = candidate;
    }
  }
  return strongest;
}
