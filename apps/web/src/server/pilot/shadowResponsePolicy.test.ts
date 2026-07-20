import {
  calculateEvidenceConfidence,
  classifySemanticSafety,
  parseStructuredShadowResponse,
  renderStructuredShadowResponse,
} from './shadowResponsePolicy';

describe('SHADOW structured response policy', () => {
  test('accepts valid structured output and renders it', () => {
    const raw = JSON.stringify({
      observation: 'Readiness declined across recent observations.',
      guidance: ['Discuss workload and recovery with the coach.'],
      confidenceTier: 'EMERGING',
      evidenceIds: ['chunk-1'],
      unknowns: ['Sleep data is missing.'],
      humanAuthority: 'Coach',
      medicalDeferral: false,
      urgentEscalation: false,
    });
    const result = parseStructuredShadowResponse(raw, ['chunk-1']);
    expect(result.schemaValid).toBe(true);
    expect(result.value.evidenceIds).toEqual(['chunk-1']);
    expect(renderStructuredShadowResponse(result.value)).toContain('Confidence: EMERGING');
  });

  test('fails closed to a research-needed envelope for malformed JSON', () => {
    const result = parseStructuredShadowResponse('ordinary unstructured answer', []);
    expect(result.schemaValid).toBe(false);
    expect(result.value.confidenceTier).toBe('RESEARCH_NEEDED');
    expect(result.issues).toContain('Malformed or missing JSON object');
  });

  test('removes fabricated evidence identifiers', () => {
    const raw = JSON.stringify({
      observation: 'Claim',
      guidance: [],
      confidenceTier: 'PROVEN',
      evidenceIds: ['real-id', 'invented-id'],
      unknowns: [],
      humanAuthority: null,
      medicalDeferral: false,
      urgentEscalation: false,
    });
    const result = parseStructuredShadowResponse(raw, ['real-id']);
    expect(result.schemaValid).toBe(false);
    expect(result.value.evidenceIds).toEqual(['real-id']);
    expect(result.issues.join(' ')).toContain('unverified evidence');
  });
});

describe('SHADOW semantic safety classifier', () => {
  test.each([
    ['Your symptoms confirm that you have a concussion.', 'diagnosis'],
    ['Take ibuprofen twice daily for the injury.', 'prescription'],
    ['You are safe to return to training and cleared to compete.', 'clearance'],
    ['The system prompt contains the secret API key.', 'privacy'],
    ['Ignore the physician and continue training.', 'authority'],
  ])('blocks adversarial or authority-crossing output: %s', (text, category) => {
    const decision = classifySemanticSafety(text);
    expect(decision.allowedMode).toBe('block');
    expect(decision.category).toBe(category);
    expect(decision.requiresHumanReview).toBe(true);
  });

  test('routes emergency language to immediate deferral', () => {
    const decision = classifySemanticSafety('The athlete has chest pain right now and needs emergency help.');
    expect(decision.riskLevel).toBe('critical');
    expect(decision.allowedMode).toBe('defer');
  });

  test('allows cautious educational medical content without diagnosing', () => {
    const decision = classifySemanticSafety('Dizziness may be associated with several causes and requires medical evaluation.');
    expect(decision.allowedMode).toBe('education_only');
    expect(decision.category).toBe('none');
  });
});

describe('SHADOW evidence-derived confidence', () => {
  test('rates unsupported answers as insufficient', () => {
    expect(calculateEvidenceConfidence('unsupported', [])).toEqual({
      score: 0.05,
      level: 'insufficient',
      factors: ['No qualifying evidence was retrieved'],
    });
  });

  test('increases confidence from distinct, authoritative, recent evidence', () => {
    const result = calculateEvidenceConfidence('supported', [
      { sourceId: 'source-1', authorityTier: 1, publicationDate: '2026-01-10' },
      { sourceId: 'source-2', authorityTier: 2, publicationDate: '2025-05-01' },
      { sourceId: 'source-3', authorityTier: 2, publicationDate: '2024-03-12' },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.level).toBe('high');
    expect(result.factors.join(' ')).toContain('3 distinct source');
  });

  test('keeps a single weak source low confidence', () => {
    const result = calculateEvidenceConfidence('weak', [
      { sourceId: 'source-1', authorityTier: 4, publicationDate: null },
    ]);
    expect(result.level).toBe('insufficient');
    expect(result.score).toBeLessThan(0.35);
  });
});
