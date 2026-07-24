jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { queryOne } from './db';
import { createShadowResearchRequirement } from './shadowResearch';

const mockQueryOne = jest.mocked(queryOne);

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
