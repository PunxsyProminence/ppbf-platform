import type { ShadowEvidenceAvailability } from './shadowEvidence';

// Distinct from explainability.confidence (0-100 numeric) and the formula
// engine's ConfidenceState (HIGH/MODERATE/LOW/INSUFFICIENT, data-completeness)
// -- this is a client-facing label for how much verified evidence actually
// backed a given chat response, independent of either of those.
export type ShadowEvidenceTier = 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'RESEARCH_NEEDED';

export function deriveEvidenceTier(input: {
  // True only for a genuine, successfully generated answer (state === 'ok').
  // Filtered/degraded/queued responses never had a real evidenced answer to
  // grade, so they always resolve to the lowest tier below.
  isAnsweredState: boolean;
  evidenceAvailability: ShadowEvidenceAvailability;
  citationCount: number;
}): ShadowEvidenceTier {
  if (!input.isAnsweredState || input.evidenceAvailability === 'unavailable') {
    return 'RESEARCH_NEEDED';
  }
  if (input.citationCount >= 2) {
    return 'PROVEN';
  }
  if (input.citationCount === 1) {
    return 'EMERGING';
  }
  return 'EXPERIMENTAL';
}
