import {
  alsoCitedTiers,
  deriveEvidenceTier,
  gradeableEvidence,
  gradeCitedEvidence,
  selectStrongestEvidence,
  type ShadowEvidenceQuality,
} from './shadowEvidenceTier';

function evidence(overrides: Partial<ShadowEvidenceQuality> = {}): ShadowEvidenceQuality {
  return {
    evidenceClass: 'VERIFIED EVIDENCE',
    authorityTier: 1,
    boxingSpecificity: 'boxing_specific',
    ...overrides,
  };
}

describe('deriveEvidenceTier', () => {
  // The answer-state gate is unchanged by the quality-weighted rewrite --
  // these two cases must resolve to RESEARCH_NEEDED regardless of how
  // strong the evidence looks.
  test('returns RESEARCH_NEEDED for any non-answered state regardless of evidence quality', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: false,
      evidenceAvailability: 'available',
      strongestEvidence: evidence(),
    })).toBe('RESEARCH_NEEDED');
  });

  test('returns RESEARCH_NEEDED when no evidence was available in scope, even if answered', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'unavailable',
      strongestEvidence: null,
    })).toBe('RESEARCH_NEEDED');
  });

  test('returns EXPERIMENTAL when answered, evidence was available in scope, but nothing was cited', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: null,
    })).toBe('EXPERIMENTAL');
  });

  test('returns RESEARCH_NEEDED for INSUFFICIENT EVIDENCE', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: evidence({ evidenceClass: 'INSUFFICIENT EVIDENCE' }),
    })).toBe('RESEARCH_NEEDED');
  });

  test.each([
    'CONTESTED PRACTICE',
    'HYPOTHESIS REQUIRING TESTING',
    'COACHING/FILM-STUDY INTERPRETATION',
  ] as const)('returns EXPERIMENTAL for %s regardless of authority tier or boxing specificity', (evidenceClass) => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: evidence({ evidenceClass, authorityTier: 1, boxingSpecificity: 'boxing_specific' }),
    })).toBe('EXPERIMENTAL');
  });

  test('a contested claim can NEVER read as PROVEN -- the point of the rewrite', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: evidence({ evidenceClass: 'CONTESTED PRACTICE', authorityTier: 1, boxingSpecificity: 'boxing_specific' }),
    })).not.toBe('PROVEN');
  });

  describe('STRONG EVIDENCE-SUPPORTED INFERENCE', () => {
    test('returns EMERGING at authority tier <= 3', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 3 }),
      })).toBe('EMERGING');
    });

    test('returns EXPERIMENTAL at authority tier > 3', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 4 }),
      })).toBe('EXPERIMENTAL');
    });

    test('never reaches PROVEN, even at authority tier 1 and boxing-specific', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({
          evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 1, boxingSpecificity: 'boxing_specific',
        }),
      })).toBe('EMERGING');
    });
  });

  describe('VERIFIED EVIDENCE', () => {
    test('returns PROVEN at authority tier <= 2 AND boxing_specific', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 2, boxingSpecificity: 'boxing_specific' }),
      })).toBe('PROVEN');
    });

    test('returns PROVEN at authority tier <= 2 AND ppbf_specific', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 1, boxingSpecificity: 'ppbf_specific' }),
      })).toBe('PROVEN');
    });

    // The invariant the spec calls out explicitly: transferred evidence
    // never reaches PROVEN, however authoritative the source.
    test('does NOT return PROVEN at authority tier 1 when evidence is transferred', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 1, boxingSpecificity: 'transferred' }),
      })).toBe('EMERGING');
    });

    test('does NOT return PROVEN at authority tier 1 when only partly boxing-specific', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 1, boxingSpecificity: 'partly_boxing_specific' }),
      })).toBe('EMERGING');
    });

    test('returns EMERGING at authority tier 3, boxing-specific or not', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 3, boxingSpecificity: 'boxing_specific' }),
      })).toBe('EMERGING');
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 3, boxingSpecificity: 'transferred' }),
      })).toBe('EMERGING');
    });

    test('returns EXPERIMENTAL at authority tier > 3', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 4, boxingSpecificity: 'boxing_specific' }),
      })).toBe('EXPERIMENTAL');
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 5, boxingSpecificity: 'transferred' }),
      })).toBe('EXPERIMENTAL');
    });

    test('authority tier 2 without boxing specificity does not reach PROVEN', () => {
      expect(deriveEvidenceTier({
        isAnsweredState: true,
        evidenceAvailability: 'available',
        strongestEvidence: evidence({ authorityTier: 2, boxingSpecificity: 'transferred' }),
      })).toBe('EMERGING');
    });
  });
});

describe('selectStrongestEvidence', () => {
  test('returns null for an empty candidate list', () => {
    expect(selectStrongestEvidence([])).toBeNull();
  });

  // Audit item 11, Jason's ruling A (relayed by Overwatch 2026-10-17): the
  // headline is the best grade any cited source earns. The old pick ranked
  // class, then tier, and named a source that grades below another one cited.
  test('Experimental -> Emerging: STRONG INFERENCE tier 1 beats VERIFIED tier 4, in either order', () => {
    const strong = evidence({ evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 1 });
    const verified = evidence({ evidenceClass: 'VERIFIED EVIDENCE', authorityTier: 4 });
    expect(gradeCitedEvidence(verified)).toBe('EXPERIMENTAL');
    expect(selectStrongestEvidence([strong, verified])).toEqual(strong);
    expect(selectStrongestEvidence([verified, strong])).toEqual(strong);
  });

  test('Emerging -> Proven: VERIFIED tier 2 boxing-specific beats VERIFIED tier 1 transferred, in either order', () => {
    const transferred = evidence({ authorityTier: 1, boxingSpecificity: 'transferred' });
    const boxing = evidence({ authorityTier: 2, boxingSpecificity: 'boxing_specific' });
    expect(gradeCitedEvidence(transferred)).toBe('EMERGING');
    expect(selectStrongestEvidence([transferred, boxing])).toEqual(boxing);
    expect(selectStrongestEvidence([boxing, transferred])).toEqual(boxing);
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: selectStrongestEvidence([transferred, boxing]),
    })).toBe('PROVEN');
  });

  test('Proven still needs a verified, boxing-specific, tier 1-2 source', () => {
    const cited = [
      evidence({ authorityTier: 1, boxingSpecificity: 'transferred' }),
      evidence({ evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 1 }),
      evidence({ authorityTier: 3, boxingSpecificity: 'boxing_specific' }),
    ];
    expect(gradeCitedEvidence(selectStrongestEvidence(cited)!)).toBe('EMERGING');
  });

  test('between two sources of the same grade, VERIFIED EVIDENCE outranks STRONG EVIDENCE-SUPPORTED INFERENCE', () => {
    const strong = evidence({ evidenceClass: 'STRONG EVIDENCE-SUPPORTED INFERENCE', authorityTier: 1 });
    const verified = evidence({ evidenceClass: 'VERIFIED EVIDENCE', authorityTier: 3 });
    expect(selectStrongestEvidence([strong, verified])).toEqual(verified);
    expect(selectStrongestEvidence([verified, strong])).toEqual(verified);
  });

  test('within the same evidence class, the lower (more authoritative) tier wins', () => {
    const weaker = evidence({ authorityTier: 4 });
    const stronger = evidence({ authorityTier: 1 });
    expect(selectStrongestEvidence([weaker, stronger])).toEqual(stronger);
  });

  test('a single candidate is returned as-is', () => {
    const only = evidence({ authorityTier: 3 });
    expect(selectStrongestEvidence([only])).toEqual(only);
  });
});

describe('alsoCitedTiers (the "Also cites" line)', () => {
  const proven = evidence({ authorityTier: 1, boxingSpecificity: 'boxing_specific' });
  const emerging = evidence({ authorityTier: 3 });
  const experimental = evidence({ evidenceClass: 'CONTESTED PRACTICE', authorityTier: 1 });

  test('lists the other grades below the headline, strongest first, once each', () => {
    expect(alsoCitedTiers('PROVEN', [experimental, proven, emerging, experimental])).toEqual(['EMERGING', 'EXPERIMENTAL']);
  });

  test('is empty when every cited source grades the same as the headline', () => {
    expect(alsoCitedTiers('EMERGING', [emerging, evidence({ authorityTier: 2, boxingSpecificity: 'transferred' })])).toEqual([]);
  });

  test('is empty under a withheld answer, which grades Research Needed whatever it cites', () => {
    expect(alsoCitedTiers('RESEARCH_NEEDED', [proven, emerging])).toEqual([]);
  });

  test('grades only rows whose metadata carries both fields, with values the rule knows', () => {
    expect(gradeableEvidence([
      { evidenceClass: 'VERIFIED EVIDENCE', boxingSpecificity: null, authorityTier: 1 },
      { evidenceClass: null, boxingSpecificity: 'boxing_specific', authorityTier: 1 },
      // Unknown values would fall into the VERIFIED branch and grade PROVEN.
      { evidenceClass: 'verified evidence', boxingSpecificity: 'boxing_specific', authorityTier: 1 },
      { evidenceClass: 'VERIFIED EVIDENCE', boxingSpecificity: 'boxing', authorityTier: 1 },
      { evidenceClass: 'VERIFIED EVIDENCE', boxingSpecificity: 'boxing_specific', authorityTier: 2 },
    ])).toEqual([{ evidenceClass: 'VERIFIED EVIDENCE', boxingSpecificity: 'boxing_specific', authorityTier: 2 }]);
  });
});
