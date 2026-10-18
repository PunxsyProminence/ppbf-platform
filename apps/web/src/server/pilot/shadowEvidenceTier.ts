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
// the real 1,193-chunk corpus, each claim graded on its source row's tier as
// runtime is: this set gives EVIDENCE_TIER_SPEC.md section 4's 122 / 821 /
// 195 / 55 (2026-09-29) with or without ppbf_specific, because no VERIFIED
// EVIDENCE + tier<=2 + ppbf_specific row exists in the corpus today -- named
// explicitly rather than left as an untested assumption for the day one does.
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

// Rank order for breaking a tie between citations that earn the same grade.
// Higher is stronger.
// Reducing a multi-citation response to one citation is a DESIGN DECISION the
// spec's own worked example (one claim, one
// evidence_class/authority_tier/boxing_specificity triple) left open: the BEST
// evidence actually cited carries the tier, the same way one Cochrane review
// among three weaker citations is still a Cochrane review. It does not mean the
// response's OTHER citations are hidden -- every citation is still shown in
// Sources, and their own grades in the "Also cites" line (alsoCitedTiers).
const EVIDENCE_CLASS_RANK: Record<ShadowEvidenceClass, number> = {
  'VERIFIED EVIDENCE': 4,
  'STRONG EVIDENCE-SUPPORTED INFERENCE': 3,
  'CONTESTED PRACTICE': 2,
  'HYPOTHESIS REQUIRING TESTING': 2,
  'COACHING/FILM-STUDY INTERPRETATION': 2,
  'INSUFFICIENT EVIDENCE': 1,
};

const TIER_STRENGTH: Record<ShadowEvidenceTier, number> = {
  PROVEN: 4,
  EMERGING: 3,
  EXPERIMENTAL: 2,
  RESEARCH_NEEDED: 1,
};

/** The grade one cited source earns on its own, by deriveEvidenceTier's rule. */
export function gradeCitedEvidence(evidence: ShadowEvidenceQuality): ShadowEvidenceTier {
  return deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', strongestEvidence: evidence });
}

/**
 * The cited source with the best grade of its own; class rank, then the lower
 * authority tier, break a tie. It used to be the best class rank, then tier,
 * which ignored boxing specificity and so could name a source that grades
 * BELOW another one cited: VERIFIED tier 1 transferred (Emerging) was picked
 * over VERIFIED tier 2 boxing-specific (Proven), and VERIFIED tier 4
 * (Experimental) over STRONG INFERENCE tier 1 (Emerging). The headline reads
 * "Strongest source", so it is now the strongest grade and never sits below an
 * "Also cites" grade (Jason, audit item 11 "A: Strongest + also-cites", relayed
 * by Overwatch 2026-10-17). Proven still needs a verified, boxing-specific,
 * tier 1-2 source.
 */
export function selectStrongestEvidence(
  candidates: ShadowEvidenceQuality[],
): ShadowEvidenceQuality | null {
  let strongest: ShadowEvidenceQuality | null = null;
  for (const candidate of candidates) {
    if (!strongest) {
      strongest = candidate;
      continue;
    }
    const candidateGrade = TIER_STRENGTH[gradeCitedEvidence(candidate)];
    const strongestGrade = TIER_STRENGTH[gradeCitedEvidence(strongest)];
    const candidateRank = EVIDENCE_CLASS_RANK[candidate.evidenceClass];
    const strongestRank = EVIDENCE_CLASS_RANK[strongest.evidenceClass];
    if (
      candidateGrade > strongestGrade
      || (candidateGrade === strongestGrade && candidateRank > strongestRank)
      || (candidateGrade === strongestGrade && candidateRank === strongestRank && candidate.authorityTier < strongest.authorityTier)
    ) {
      strongest = candidate;
    }
  }
  return strongest;
}

/** The higher of two grades. */
export function higherTier(a: ShadowEvidenceTier, b: ShadowEvidenceTier): ShadowEvidenceTier {
  return TIER_STRENGTH[b] > TIER_STRENGTH[a] ? b : a;
}

/**
 * The grades the answer's other cited sources earn, below the headline,
 * strongest first: the "Also cites" line. Empty when every cited source grades
 * the same as the headline, or the headline is not a grade of citations at all
 * (a withheld answer grades Research Needed, and nothing is below it).
 */
export function alsoCitedTiers(headline: ShadowEvidenceTier, cited: ShadowEvidenceQuality[]): ShadowEvidenceTier[] {
  const below = new Set(cited.map(gradeCitedEvidence).filter((tier) => TIER_STRENGTH[tier] < TIER_STRENGTH[headline]));
  return [...below].sort((a, b) => TIER_STRENGTH[b] - TIER_STRENGTH[a]);
}

const KNOWN_EVIDENCE_CLASSES: ReadonlySet<string> = new Set(Object.keys(EVIDENCE_CLASS_RANK));
const KNOWN_BOXING_SPECIFICITY: ReadonlySet<string> = new Set<ShadowBoxingSpecificity>([
  'boxing_specific', 'partly_boxing_specific', 'ppbf_specific', 'transferred',
]);

/**
 * The cited rows the tier can grade: those whose chunk metadata carries both
 * fields with values the rule knows. A row without them is not gradeable,
 * never a passing grade: deriveEvidenceTier reads anything that is not one of
 * the named weaker classes as VERIFIED EVIDENCE, so an unknown class string
 * would otherwise reach PROVEN -- and, picked by best grade, win from any
 * position.
 */
export function gradeableEvidence(
  rows: Array<{ evidenceClass: string | null; boxingSpecificity: string | null; authorityTier: number }>,
): ShadowEvidenceQuality[] {
  return rows
    .filter((row) => row.evidenceClass !== null && KNOWN_EVIDENCE_CLASSES.has(row.evidenceClass)
      && row.boxingSpecificity !== null && KNOWN_BOXING_SPECIFICITY.has(row.boxingSpecificity)
      && Number.isFinite(row.authorityTier))
    .map((row) => ({
      evidenceClass: row.evidenceClass as ShadowEvidenceClass,
      authorityTier: row.authorityTier,
      boxingSpecificity: row.boxingSpecificity as ShadowBoxingSpecificity,
    }));
}
