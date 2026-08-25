jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from './db';
import {
  createShadowResearchRequirement,
  getShadowResearchRequirementById,
  listShadowResearchRequirements,
  resolveShadowResearchRequirement,
} from './shadowResearch';

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
      // Fixture repair, not a change of intent: expectedSubjectAthleteId is
      // now required so no call site can omit the owner it authorized. This
      // case is the non-parent caller with NO athlete scope, so the row it
      // authorized is one that names no athlete -- null. The two assertions
      // below (no athlete scope in the SQL) are untouched.
      expectedSubjectAthleteId: null,
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
      // Fixture repair: the stored row is about a child outside this
      // guardian's scope, which is exactly what the case is describing.
      expectedSubjectAthleteId: 'athlete-not-theirs',
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
      // Fixture repair: this guardian's own child is the row's subject.
      expectedSubjectAthleteId: 'athlete-theirs',
    });

    expect(resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The owner bound, and why it lives in the WHERE rather than in a prior
  // SELECT the route trusts afterwards.
  // -------------------------------------------------------------------------
  //
  // Before this, the ONLY athlete predicate here was the parent's athleteIds
  // list, and the route set that list for `role === 'parent'` and for nobody
  // else. For a coach, athlete, volunteer, staff or organization_admin caller
  // hasAthleteScope was false, `$4::boolean = false` short-circuited the OR,
  // and the surviving WHERE was organization + id + status. Since
  // research_requirement_id is a bigserial, that is an enumerable write: name
  // a number, mark a child's follow-up handled.
  test('the UPDATE binds the owner the caller authorized, resolved the same way the route resolves it', async () => {
    mockQuery.mockResolvedValue([{ research_requirement_id: 5 }]);

    await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 5,
      resolvedByAccountId: 'coach-account-1',
      resolvedByRole: 'coach',
      expectedSubjectAthleteId: 'athlete-authorized',
    });

    const [sql, params = []] = mockQuery.mock.calls[0];

    // The same three fields, in the same priority order, as the route's
    // subjectAthleteIdOf -- the column first, then the two metadata keys the
    // subject_id migration's backfill could not populate.
    expect(sql).toContain("nullif(btrim(subject_id), '')");
    expect(sql).toContain("nullif(btrim(metadata->>'subject_id'), '')");
    expect(sql).toContain("nullif(btrim(metadata->>'athlete_id'), '')");

    // `is not distinct from`, not `=`: a row that names nobody has to still
    // name nobody. With `=` the predicate would go NULL and drop out
    // entirely, which is the no-op this test exists to prevent.
    expect(sql).toContain('is not distinct from $6::text');

    expect(params[5]).toBe('athlete-authorized');
  });

  test('a row that names no athlete is bound as naming no athlete', async () => {
    mockQuery.mockResolvedValue([{ research_requirement_id: 7 }]);

    await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 7,
      resolvedByAccountId: 'coach-account-1',
      resolvedByRole: 'coach',
      expectedSubjectAthleteId: null,
    });

    const [, params = []] = mockQuery.mock.calls[0];
    expect(params[5]).toBeNull();
  });

  // Attribution is the server's to state. The actor fields used to be spread
  // FIRST and the caller's own metadata spread over the top of them, so any
  // admitted role could resolve a requirement while passing
  // {resolved_by_account_id, resolved_by_role} naming somebody else -- and the
  // stored row would then say that somebody else handled a
  // safeguarding-adjacent follow-up about a child.
  test('caller metadata cannot forge who resolved the requirement', async () => {
    mockQuery.mockResolvedValue([{ research_requirement_id: 9 }]);

    await resolveShadowResearchRequirement({
      organizationId: 'org-1',
      researchRequirementId: 9,
      resolvedByAccountId: 'coach-account-1',
      resolvedByRole: 'coach',
      expectedSubjectAthleteId: null,
      metadata: {
        resolved_by_account_id: 'acct-head-coach',
        resolved_by_role: 'organization_admin',
        resolved_from: 'research_page',
      },
    });

    const [, params = []] = mockQuery.mock.calls[0];
    const merged = JSON.parse(params[2] as string) as Record<string, unknown>;

    expect(merged.resolved_by_account_id).toBe('coach-account-1');
    expect(merged.resolved_by_role).toBe('coach');
    // Everything the caller legitimately notes is still merged.
    expect(merged.resolved_from).toBe('research_page');
  });
});

describe('getShadowResearchRequirementById', () => {
  // The authorization decision has to be made against the STORED row, so the
  // read that feeds it must return the fields the subject resolution needs and
  // must be organization-scoped -- a cross-organization id reads as absent.
  test('reads one row by id within one organization, carrying subject_id and metadata', async () => {
    mockQueryOne.mockResolvedValue(null);

    await getShadowResearchRequirementById('org-1', 42);

    const [sql, params = []] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('subject_id');
    expect(sql).toContain('metadata');
    expect(sql).toContain('where organization_id = $1');
    expect(sql).toContain('and research_requirement_id = $2');
    expect(params).toEqual(['org-1', 42]);
  });
});
