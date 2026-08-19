import {
  RESEARCH_CLASSIFICATION_DOMAINS,
  isResearchClassificationDomain,
  researchClassificationArchiveCode,
  researchClassificationLabel,
} from './researchClassification';

describe('research classification taxonomy', () => {
  test('covers the governed subject archive from R01 through R19 exactly once', () => {
    const expectedCodes = Array.from({ length: 19 }, (_value, index) => (
      `R${String(index + 1).padStart(2, '0')}`
    ));
    const actualCodes = RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.archiveCode);

    expect(actualCodes).toEqual(expectedCodes);
    expect(new Set(actualCodes).size).toBe(19);
    expect(new Set(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.key)).size).toBe(19);
    expect(new Set(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.label)).size).toBe(19);
  });

  test('includes the five archive domains added after the original issue-345 taxonomy', () => {
    expect(RESEARCH_CLASSIFICATION_DOMAINS.slice(-5)).toEqual([
      { key: 'water_safety_aquatics', label: 'Water safety and aquatics', archiveCode: 'R15' },
      { key: 'adaptive_inclusive_practice', label: 'Adaptive and inclusive practice', archiveCode: 'R16' },
      { key: 'multidiscipline_wrestling_grappling', label: 'Multidiscipline wrestling and grappling', archiveCode: 'R17' },
      { key: 'learning_science_skill_acquisition', label: 'Learning science and skill acquisition', archiveCode: 'R18' },
      { key: 'measurement_assessment_instruments', label: 'Measurement and assessment instruments', archiveCode: 'R19' },
    ]);
  });

  test('accepts only controlled subject-domain keys', () => {
    for (const domain of RESEARCH_CLASSIFICATION_DOMAINS) {
      expect(isResearchClassificationDomain(domain.key)).toBe(true);
    }

    expect(isResearchClassificationDomain('R00')).toBe(false);
    expect(isResearchClassificationDomain('duplicate_hold')).toBe(false);
    expect(isResearchClassificationDomain('astrology')).toBe(false);
    expect(isResearchClassificationDomain(null)).toBe(false);
  });

  test('resolves human labels and archive codes without inventing a fallback code', () => {
    expect(researchClassificationLabel('adaptive_inclusive_practice')).toBe('Adaptive and inclusive practice');
    expect(researchClassificationArchiveCode('adaptive_inclusive_practice')).toBe('R16');

    expect(researchClassificationLabel('unknown_domain')).toBe('unknown_domain');
    expect(researchClassificationArchiveCode('unknown_domain')).toBeNull();
  });
});
