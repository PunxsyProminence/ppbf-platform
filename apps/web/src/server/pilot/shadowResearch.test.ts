jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from './db';
import { createShadowResearchRequirement, resolveShadowResearchRequirement } from './shadowResearch';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SHADOW research requirements', () => {
  test('uses the durable source tuple as an idempotency key', async () => {
    mockQueryOne.mockResolvedValue({ research_requirement_id: 81 });
    const input = {
      organizationId: 'org-1',
      sourceEventName: 'shadow_learning_negative_outcome',
      sourceEntityType: 'shadow_learning_event',
      sourceEntityId: 'message-1',
      researchRequirement: 'Investigate the reviewed negative outcome.',
      knowledgeGap: 'Verified evidence is incomplete.',
      evidenceLabel: 'Human-reviewed negative outcome',
      sourceStatus: 'weak',
      sourceConfidenceTier: 'LIMITED' as const,
      sourceVerificationState: 'unverified' as const,
      createdByAccountId: 'account-1',
      createdByRole: 'athlete',
    };

    await expect(createShadowResearchRequirement(input)).resolves.toBe(81);
    await expect(createShadowResearchRequirement(input)).resolves.toBe(81);

    const sql = mockQueryOne.mock.calls[0][0];
    expect(sql).toContain(
      'on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)',
    );
    expect(sql).toContain('returning research_requirement_id');
  });
});

describe('resolveShadowResearchRequirement', () => {
  test('resolves without an athlete scope (non-parent caller)', async () => {
    mockQuery.mockResolvedValue([{ research_requirement_id: 5 }]);

    const resolved = await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 5,
      resolvedByAccountId: 'account-1',
      resolvedByRole: 'coach',
    });

    expect(resolved).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("and status = 'open'");
    expect(params[3]).toBe(false);
    expect(params[4]).toEqual([]);
  });

  test('a parent cannot resolve a requirement outside their athlete scope', async () => {
    // The where clause itself does the filtering; simulate the DB returning
    // zero rows because the row's source_entity_id/evidence_label/subject_id
    // matched none of the caller's linked athlete IDs.
    mockQuery.mockResolvedValue([]);

    const resolved = await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 5,
      resolvedByAccountId: 'parent-account-1',
      resolvedByRole: 'parent',
      athleteIds: ['athlete-not-theirs'],
    });

    expect(resolved).toBe(false);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('source_entity_id = any($5::text[])');
    expect(params[3]).toBe(true);
    expect(params[4]).toEqual(['athlete-not-theirs']);
  });

  test('a parent can resolve a requirement tied to their own linked athlete', async () => {
    mockQuery.mockResolvedValue([{ research_requirement_id: 5 }]);

    const resolved = await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 5,
      resolvedByAccountId: 'parent-account-1',
      resolvedByRole: 'parent',
      athleteIds: ['athlete-theirs'],
    });

    expect(resolved).toBe(true);
  });
});
