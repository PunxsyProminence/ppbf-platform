import { deriveEvidenceTier } from './shadowEvidenceTier';

describe('deriveEvidenceTier', () => {
  test('returns RESEARCH_NEEDED for any non-answered state regardless of evidence', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: false,
      evidenceAvailability: 'available',
      citationCount: 3,
    })).toBe('RESEARCH_NEEDED');
  });

  test('returns RESEARCH_NEEDED when no evidence was available in scope, even if answered', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'unavailable',
      citationCount: 0,
    })).toBe('RESEARCH_NEEDED');
  });

  test('returns PROVEN when answered with two or more citations', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      citationCount: 2,
    })).toBe('PROVEN');
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      citationCount: 5,
    })).toBe('PROVEN');
  });

  test('returns EMERGING when answered with exactly one citation', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      citationCount: 1,
    })).toBe('EMERGING');
  });

  test('returns EXPERIMENTAL when answered, evidence was available in scope, but nothing was cited', () => {
    expect(deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      citationCount: 0,
    })).toBe('EXPERIMENTAL');
  });
});
