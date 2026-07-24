import { buildExplanationChain, formatExplanation } from './shadowExplainability';
import type { ShadowUserProfileRow } from './shadowUserProfile';
import type { ProfileTierResult } from './shadowProfiling';

const profile = {} as ShadowUserProfileRow;
const tier = { tier: 'gold', config: { label: 'Gold' } } as ProfileTierResult;

describe('SHADOW explainability evidence boundary', () => {
  test('reports confidence unavailable when no verified evidence descriptors are supplied', async () => {
    const chain = await buildExplanationChain('Review the training plan.', profile, tier);

    expect(chain.confidence).toBeNull();
    expect(chain.confidenceLevel).toBe('⚪ Unavailable');
    expect(chain.reasoning).toContain('RESEARCH NEEDED');
    expect(chain.evidenceLinks).toEqual([]);
    expect(JSON.stringify(chain)).not.toContain('Verified Library Source');
    expect(formatExplanation(chain)).toContain('Confidence:** ⚪ Unavailable');
  });

  test('rejects descriptors without a source ID instead of treating them as verified', async () => {
    const chain = await buildExplanationChain('Review the training plan.', profile, tier, [
      {
        type: 'library',
        label: 'Untraceable source',
        sourceId: '',
        verificationState: 'verified',
        confidence: 0.99,
      },
    ]);

    expect(chain.confidence).toBeNull();
    expect(chain.evidenceLinks).toHaveLength(0);
  });

  test('computes confidence only from verified, source-linked descriptors', async () => {
    const chain = await buildExplanationChain('Review the training plan.', profile, tier, [
      {
        type: 'library',
        label: 'Reviewed coaching protocol',
        sourceId: 'library-item-123',
        source: 'shadow_library',
        verificationState: 'verified',
        confidence: 0.8,
        weight: 0.75,
      },
      {
        type: 'assessment',
        label: 'Reviewed assessment',
        sourceId: 'assessment-456',
        source: 'shadow_events',
        verificationState: 'verified',
        confidence: 0.6,
        weight: 0.25,
      },
    ]);

    expect(chain.confidence).toBeCloseTo(75);
    expect(chain.evidenceLinks).toHaveLength(2);
    expect(chain.evidenceLinks[0]).toEqual(expect.objectContaining({
      sourceId: 'library-item-123',
      verificationState: 'verified',
    }));
    expect(formatExplanation(chain)).toContain('[source: library-item-123]');
    expect(chain.alternatives?.every((alternative) => alternative.confidence === null)).toBe(true);
  });
});
