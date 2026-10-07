import {
  AUDIT_ATHLETE_OWNED_ENTITY_TYPES,
  auditEntityOwnersOf,
  resolveAuditEntityOwners,
} from './auditEntityOwners';
import { query } from './db';

jest.mock('./db', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

const mockQuery = query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
});

/**
 * Where each type's owner is read from. The table named here is the one the
 * writer's entity_id keys into (see the module header); a lookup that read a
 * different table would resolve the wrong child or nothing at all.
 */
const TABLE_BY_TYPE: Record<string, string> = {
  athlete_milestone: 'pilot.athlete_milestones',
  athlete_program: 'pilot.athletes',
  coach_coverage: 'pilot.coach_coverage',
  coach_note: 'pilot.coach_observations',
  coach_review: 'pilot.coach_reviews',
  external_competition_entry: 'pilot.external_competition_entries',
  goal: 'pilot.goals',
  intervention_evidence_link: 'pilot.intervention_evidence_links',
  intervention_execution: 'pilot.intervention_executions',
  intervention_outcome_review: 'pilot.intervention_outcome_reviews',
  mentorship: 'pilot.mentorships',
  one_percent_nomination: 'pilot.one_percent_nominations',
  recognition: 'pilot.recognitions',
  scheduler_coaching_request: 'pilot.scheduler_coaching_requests',
  session: 'pilot.sessions',
  video_session: 'pilot.video_sessions',
  wrestling_league_roster_entry: 'pilot.wrestling_league_roster_entries',
};

describe('resolveAuditEntityOwners', () => {
  test('every athlete-owned type has a lookup, and nothing else does', () => {
    expect([...AUDIT_ATHLETE_OWNED_ENTITY_TYPES].sort()).toEqual(Object.keys(TABLE_BY_TYPE).sort());
  });

  test.each(Object.keys(TABLE_BY_TYPE))(
    '%s reads its own table, bound to the organization and the ids asked for',
    async (entityType) => {
      mockQuery.mockResolvedValueOnce([
        { entity_id: 'e-1', athlete_id: 'ath-1' },
        { entity_id: 'e-2', athlete_id: 'ath-2' },
      ]);

      const result = await resolveAuditEntityOwners('org-a', [
        { entity_type: entityType, entity_id: 'e-1' },
        { entity_type: entityType, entity_id: 'e-2' },
        { entity_type: entityType, entity_id: 'e-1' }, // duplicate collapses
      ]);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(TABLE_BY_TYPE[entityType]);
      expect(sql).toMatch(/organization_id = \$1/);
      expect(sql).toMatch(/any\(\$2::text\[\]\)/);
      expect(params).toEqual(['org-a', ['e-1', 'e-2']]);
      expect(auditEntityOwnersOf(result, entityType, 'e-1')).toEqual(['ath-1']);
      expect(auditEntityOwnersOf(result, entityType, 'e-2')).toEqual(['ath-2']);
      expect(auditEntityOwnersOf(result, entityType, 'e-missing')).toBeNull();
    },
  );

  test('the join types key the child on both halves of the composite key', () => {
    // A session_id or execution_id can name a different child in another
    // gym; each join must carry organization_id as well as the id.
    for (const type of ['coach_review', 'intervention_evidence_link', 'intervention_outcome_review']) {
      mockQuery.mockClear();
      void resolveAuditEntityOwners('org-a', [{ entity_type: type, entity_id: 'x' }]);
      const [sql] = mockQuery.mock.calls[0] as [string];
      expect(sql).toMatch(/join pilot\.\w+ \w+\s+on \w+\.organization_id = \w+\.organization_id and/);
    }
  });

  test('one statement per type present; types that are not athlete-owned are ignored', async () => {
    await resolveAuditEntityOwners('org-a', [
      { entity_type: 'goal', entity_id: 'g-1' },
      { entity_type: 'session', entity_id: 's-1' },
      { entity_type: 'announcement', entity_id: 'a-1' },
      { entity_type: 'not_a_type', entity_id: 'n-1' },
    ]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const tables = mockQuery.mock.calls.map(([sql]: [string]) => (sql.includes('pilot.goals') ? 'goals' : sql.includes('pilot.sessions') ? 'sessions' : 'other'));
    expect(tables.sort()).toEqual(['goals', 'sessions']);
  });

  test('a mentorship resolves to both athletes; a null athlete (teaching footage) resolves to nothing', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { entity_id: 'm-1', athlete_id: 'ath-mentor' },
        { entity_id: 'm-1', athlete_id: 'ath-mentee' },
      ])
      .mockResolvedValueOnce([{ entity_id: 'v-teach', athlete_id: null }]);

    const result = await resolveAuditEntityOwners('org-a', [
      { entity_type: 'mentorship', entity_id: 'm-1' },
      { entity_type: 'video_session', entity_id: 'v-teach' },
    ]);

    expect(auditEntityOwnersOf(result, 'mentorship', 'm-1')).toEqual(['ath-mentor', 'ath-mentee']);
    expect(auditEntityOwnersOf(result, 'video_session', 'v-teach')).toBeNull();
  });

  test('empty and non-string entity ids are never sent to the database', async () => {
    await resolveAuditEntityOwners('org-a', [
      { entity_type: 'goal', entity_id: '' },
      { entity_type: 'goal', entity_id: 42 as unknown as string },
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
