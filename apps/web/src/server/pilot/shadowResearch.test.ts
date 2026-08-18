jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from './db';
import { createShadowResearchRequirement, listShadowResearchRequirements, resolveShadowResearchRequirement } from './shadowResearch';

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

  // subject_id mirrors pilot.shadow_library_documents.subject_id: a plain
  // insert column, not part of the idempotency key above, so it must land at
  // its own parameter position rather than inside the ON CONFLICT clause.
  test('inserts subject_id as a plain column at its own parameter position', async () => {
    mockQueryOne.mockResolvedValue({ research_requirement_id: 82 });

    await createShadowResearchRequirement({
      organizationId: 'org-1',
      sourceEventName: 'SHADOW_INTAKE_CASE_APPROVED',
      sourceEntityType: 'intake_case',
      sourceEntityId: 'case-1',
      researchRequirement: 'Confirm approval evidence.',
      knowledgeGap: 'Awaiting stronger evidence.',
      evidenceLabel: null,
      sourceStatus: 'observed',
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW' as const,
      sourceVerificationState: 'unknown' as const,
      createdByAccountId: 'account-1',
      createdByRole: 'coach',
      subjectId: 'athlete-1',
    });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('subject_id');
    expect(params?.at(-1)).toBe('athlete-1');
  });

  test('an absent subjectId inserts null rather than undefined', async () => {
    mockQueryOne.mockResolvedValue({ research_requirement_id: 83 });

    await createShadowResearchRequirement({
      organizationId: 'org-1',
      sourceEventName: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
      sourceEntityType: 'shadow_library_capability_map',
      sourceEntityId: 'cap-1',
      researchRequirement: 'Close coverage gap.',
      knowledgeGap: 'No qualifying sources.',
      evidenceLabel: 'cap-1',
      sourceStatus: 'missing',
      sourceConfidenceTier: 'INSUFFICIENT' as const,
      sourceVerificationState: 'unknown' as const,
      createdByAccountId: 'account-1',
      createdByRole: 'coach',
    });

    const [, params] = mockQueryOne.mock.calls[0];
    expect(params?.at(-1)).toBeNull();
  });
});

describe('listShadowResearchRequirements', () => {
  test('scopes to the subject_id column only -- the retired 3-field heuristic is gone', async () => {
    mockQuery.mockResolvedValue([]);

    await listShadowResearchRequirements('org-1', { athleteIds: ['athlete-1'] });

    const [sql, params = []] = mockQuery.mock.calls[0];
    expect(sql).toContain('resolved_at,\n       subject_id');
    expect(sql).toContain('or subject_id = any($4::text[])');
    expect(sql).not.toContain('source_entity_id = any');
    expect(sql).not.toContain('evidence_label = any');
    expect(sql).not.toContain("metadata->>'subject_id'");
    expect(params[2]).toBe(true);
    expect(params[3]).toEqual(['athlete-1']);
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
    const [sql, params = []] = mockQuery.mock.calls[0];
    expect(sql).toContain("and status = 'open'");
    expect(params[3]).toBe(false);
    expect(params[4]).toEqual([]);
  });

  test('a parent cannot resolve a requirement outside their athlete scope', async () => {
    // The where clause itself does the filtering; simulate the DB returning
    // zero rows because the row's subject_id matched none of the caller's
    // linked athlete IDs.
    mockQuery.mockResolvedValue([]);

    const resolved = await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 5,
      resolvedByAccountId: 'parent-account-1',
      resolvedByRole: 'parent',
      athleteIds: ['athlete-not-theirs'],
    });

    expect(resolved).toBe(false);
    const [sql, params = []] = mockQuery.mock.calls[0];
    expect(sql).toContain('or subject_id = any($5::text[])');
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
