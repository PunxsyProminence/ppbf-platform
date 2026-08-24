import { query } from './db';
import { listShadowEvents, listShadowTelemetry, listShadowAuthorityChecks, getShadowReviewProjection, getShadowResearchProjection } from './shadowReadModels';
import type { ShadowReadContext } from './shadowReadModels';

jest.mock('./db', () => ({
  query: jest.fn(),
}));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function context(overrides: Partial<ShadowReadContext>): ShadowReadContext {
  return {
    organizationId: 'org-1',
    actorAccountId: 'acct-1',
    actorRole: 'coach',
    athleteId: null,
    ...overrides,
  };
}

/**
 * A coach's scope is now resolved through athleteIdsForCoach, which runs its
 * own query against the same mocked `query`. Every coach-context test
 * therefore answers that lookup FIRST -- it is call 0, and the read-model's
 * own query is the one after it.
 */
function answerCoachRoster(athleteIds: string[]): void {
  mockQuery.mockResolvedValueOnce(athleteIds.map((athlete_id) => ({ athlete_id })));
}

// The bind parameters carry the values; the SQL carries the predicate they are
// bound into. Pinning only one of the two lets the other be deleted silently:
// a correct athlete list bound into a query that no longer filters on it reads
// exactly like a fix. Whitespace is normalized so the assertions survive
// reformatting but not a removed disjunct.
function sqlOf(callIndex: number): string {
  return String(mockQuery.mock.calls[callIndex][0]).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('listShadowEvents athlete scoping', () => {
  test('athlete role restricts the query to their own athleteId only', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'athlete', athleteId: 'ath-1' }));

    const params = mockQuery.mock.calls[0][1];
    const restrictToAthleteIds = params[8];
    const includeUnscopedRows = params[9];
    expect(restrictToAthleteIds).toEqual(['ath-1']);
    expect(includeUnscopedRows).toBe(false);
  });

  test('parent role restricts the query to their linked athletes, not the whole org', async () => {
    // First call: guardian_links lookup inside resolveAthleteScope.
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-linked-1' }, { athlete_id: 'ath-linked-2' }]);
    // Second call: the actual shadow_events query.
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'parent', actorAccountId: 'parent-acct-1' }));

    const guardianLinksCallParams = mockQuery.mock.calls[0][1];
    expect(guardianLinksCallParams).toEqual(['org-1', 'parent-acct-1']);

    const eventsCallParams = mockQuery.mock.calls[1][1];
    const restrictToAthleteIds = eventsCallParams[8];
    expect(restrictToAthleteIds).toEqual(['ath-linked-1', 'ath-linked-2']);
    // A guardian reads their child's rows, not the gym's operational stream.
    expect(eventsCallParams[9]).toBe(false);
  });

  test('parent with no linked athletes gets a scope that matches nothing, not the whole org', async () => {
    mockQuery.mockResolvedValueOnce([]); // no guardian links found
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'parent' }));

    const eventsCallParams = mockQuery.mock.calls[1][1];
    expect(eventsCallParams[8]).toEqual(['__unbound_athlete__']);
  });

  test('volunteer role excludes all athlete-scoped rows instead of seeing every athlete in the org', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'volunteer' }));

    const params = mockQuery.mock.calls[0][1];
    // The EMPTY list, never null: `= any('{}')` is false for every row, so no
    // athlete-tied row matches. Null would mean "unrestricted" and is what the
    // organization admin gets.
    expect(params[8]).toEqual([]);
    expect(params[9]).toBe(true); // athlete-free operational rows still visible
  });

  test('a coach is scoped to their own roster, not to every athlete in the organization', async () => {
    // The defect this replaces: a coach fell through resolveAthleteScope to
    // restrictToAthleteIds = null -- no athlete restriction at all -- so
    // /api/pilot/shadow/events answered a caller-supplied entity_id for ANY
    // athlete in the org, and roleCanViewSensitivePayload returns true for a
    // coach, so pain reports came back with body site, pain type and severity.
    answerCoachRoster(['ath-mine-1', 'ath-mine-2']);
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'coach', actorAccountId: 'coach-1' }));

    // The roster lookup is athleteIdsForCoach: coach_id of record UNION
    // active, unexpired coverage -- the same contract every other coach-facing
    // aggregate derives its scope from.
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'coach-1']);
    expect(sqlOf(0)).toContain('coach_coverage');

    const params = mockQuery.mock.calls[1][1];
    expect(params[8]).toEqual(['ath-mine-1', 'ath-mine-2']);
    expect(params[9]).toBe(true);
  });

  test('a coach who currently reaches no athlete gets the empty set, never null', async () => {
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'coach' }));

    // Null here would be "unrestricted" -- the exact defect. An empty roster
    // is a real answer: no athlete's rows, and the operational feed intact.
    expect(mockQuery.mock.calls[1][1][8]).toEqual([]);
    expect(mockQuery.mock.calls[1][1][9]).toBe(true);
  });

  test.each(['organization_admin', 'admin'] as const)(
    '%s stays unrestricted across the whole organization',
    async (actorRole) => {
      mockQuery.mockResolvedValueOnce([]);
      await listShadowEvents(context({ actorRole }));

      const params = mockQuery.mock.calls[0][1];
      expect(params[8]).toBeNull();
      expect(params[9]).toBe(true);
    },
  );

  test.each(['platform_owner', 'board', 'staff'] as const)(
    '%s reaches no athlete-tied row -- assertActorCanAccessAthlete refuses each of them outright',
    async (actorRole) => {
      // platform_owner and board are refused by name in
      // assertActorCanAccessAthlete; staff falls through its final refusal
      // exactly as volunteer does. shadowRoleSets.ts additionally states the
      // Omega tier "must never reach protected health information ... in any
      // organization", which an org-wide unredacted pain-report read is.
      mockQuery.mockResolvedValueOnce([]);
      await listShadowEvents(context({ actorRole }));

      const params = mockQuery.mock.calls[0][1];
      expect(params[8]).toEqual([]);
      expect(params[9]).toBe(true);
    },
  );

  test('the events boundary keeps the athlete list and the athlete-free rows as separate disjuncts', async () => {
    // With the athlete list alone the predicate is EXCLUSIVE: only rows tied
    // to those ids match, so scoping a coach and stopping there would delete
    // every intake/library/formula/job event from their feed. Measured on a
    // real PostgreSQL 16 over an 8-row fixture: 5 rows survive with both
    // disjuncts, 1 with the athlete list alone.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'coach' }));

    const sql = sqlOf(1);
    expect(sql).toContain("$9::text[] is null or (entity_type = 'athlete' and entity_id = any($9::text[]))");
    expect(sql).toContain("payload->>'athlete_id' = any($9::text[])");
    expect(sql).toContain("payload->>'owner_entity_id' = any($9::text[])");
    expect(sql).toContain(
      "or ($10::boolean and entity_type <> 'athlete' and payload->>'athlete_id' is null and payload->>'owner_entity_id' is null)",
    );
  });
});

describe('listShadowTelemetry athlete scoping', () => {
  test('volunteer role excludes athlete-tied telemetry', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowTelemetry(context({ actorRole: 'volunteer' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[6]).toEqual([]);
    expect(params[7]).toBe(true);
  });

  test('a coach is scoped to their own roster here too', async () => {
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);

    await listShadowTelemetry(context({ actorRole: 'coach', actorAccountId: 'coach-1' }));

    const params = mockQuery.mock.calls[1][1];
    expect(params[6]).toEqual(['ath-mine']);
    expect(params[7]).toBe(true);
  });

  test('telemetry treats a row as athlete-free only when no dimension names an athlete', async () => {
    // dimensions->>'athlete_id' is null alone is not enough: a blob naming an
    // athlete through entity_type/entity_id or owner_entity_id is athlete-tied
    // whether or not it also carries athlete_id, and the athlete-free disjunct
    // would hand it back to the very roles the first disjunct excluded.
    mockQuery.mockResolvedValueOnce([]);
    await listShadowTelemetry(context({ actorRole: 'volunteer' }));

    const sql = sqlOf(0);
    expect(sql).toContain("$7::text[] is null or dimensions->>'athlete_id' = any($7::text[])");
    expect(sql).toContain("dimensions->>'entity_id' = any($7::text[])");
    expect(sql).toContain("dimensions->>'owner_entity_id' = any($7::text[])");
    expect(sql).toContain(
      "or ( $8::boolean and dimensions->>'athlete_id' is null and dimensions->>'owner_entity_id' is null and dimensions->>'entity_type' is distinct from 'athlete' )",
    );
  });
});

describe('getShadowReviewProjection athlete scoping', () => {
  test('parent only sees review items for their linked athletes', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-linked-1' }]); // guardian links
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'parent', actorAccountId: 'parent-1' }));

    // Indexed explicitly rather than from the end: the scope now binds two
    // values, and "the last parameter" would silently start meaning the flag.
    const itemsParams = mockQuery.mock.calls[1][1];
    const totalParams = mockQuery.mock.calls[2][1];
    expect(itemsParams[5]).toEqual(['ath-linked-1']);
    expect(itemsParams[6]).toBe(false);
    expect(totalParams[3]).toEqual(['ath-linked-1']);
    expect(totalParams[4]).toBe(false);
  });

  test('a coach sees their own athletes cases plus the cases that have no athlete yet', async () => {
    // Both halves matter. Scoping the coach without the second one would empty
    // the intake review queue of every case filed before its athlete record
    // exists -- which is most of what a review queue holds.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'coach', actorAccountId: 'coach-1' }));

    const itemsParams = mockQuery.mock.calls[1][1];
    const totalParams = mockQuery.mock.calls[2][1];
    expect(itemsParams[5]).toEqual(['ath-mine']);
    expect(itemsParams[6]).toBe(true);
    expect(totalParams[3]).toEqual(['ath-mine']);
    expect(totalParams[4]).toBe(true);
  });

  test('the items query and the count query carry the identical boundary', async () => {
    // Different predicates here mean the caller pages through one set of rows
    // against another set's total.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce([{ count: '0' }]);

    await getShadowReviewProjection(context({ actorRole: 'coach' }));

    expect(sqlOf(1)).toContain(
      "$6::text[] is null or c.primary_athlete_id = any($6::text[]) or ($7::boolean and c.primary_athlete_id is null)",
    );
    expect(sqlOf(2)).toContain(
      "$4::text[] is null or c.primary_athlete_id = any($4::text[]) or ($5::boolean and c.primary_athlete_id is null)",
    );
  });

  test('an organization admin remains unrestricted across the whole organization', async () => {
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'organization_admin' }));

    const itemsParams = mockQuery.mock.calls[0][1];
    expect(itemsParams[5]).toBeNull();
    expect(itemsParams[6]).toBe(true);
  });

  test('a volunteer reads no athlete-tied intake case', async () => {
    // The review projection binds restrictToAthleteIds only. Under the old
    // encoding a volunteer's scope was null here -- "unrestricted" -- so every
    // case in the organization, athlete and all, reached them through
    // /api/pilot/shadow/review-projection.
    mockQuery.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce([{ count: '0' }]);

    await getShadowReviewProjection(context({ actorRole: 'volunteer' }));

    expect(mockQuery.mock.calls[0][1][5]).toEqual([]);
    expect(mockQuery.mock.calls[0][1][6]).toBe(true);
  });
});

describe('sanitizeEventPayload', () => {
  test("a coach keeps the pain-report detail their own athlete's feed label is built from", async () => {
    // describePainReportEvent renders location, pain_type and severity_1_10
    // into the coach's observation feed. None of those survive the safe-key
    // filter, so redacting a coach would blank the label. This is legitimate
    // only because the scope above now limits a coach to their own athletes;
    // the two are a pair and neither stands alone.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 1,
        organization_id: 'org-1',
        event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
        entity_type: 'athlete',
        entity_id: 'ath-mine',
        actor_account_id: 'acct-1',
        actor_role: 'athlete',
        payload: { athlete_id: 'ath-mine', severity_1_10: 8, location: 'left knee', pain_type: 'sharp' },
        created_at: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const rows = await listShadowEvents(context({ actorRole: 'coach' }));

    expect(rows[0].payload).toEqual({
      athlete_id: 'ath-mine',
      severity_1_10: 8,
      location: 'left knee',
      pain_type: 'sharp',
    });
  });

  test('a volunteer gets the safe keys only, never body site or severity', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 1,
        organization_id: 'org-1',
        event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
        entity_type: 'athlete',
        entity_id: 'ath-1',
        actor_account_id: 'acct-1',
        actor_role: 'athlete',
        payload: { athlete_id: 'ath-1', severity_1_10: 8, location: 'left knee', pain_type: 'sharp', entity_id: 'ath-1' },
        created_at: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const rows = await listShadowEvents(context({ actorRole: 'volunteer' }));

    expect(rows[0].payload).toEqual({ entity_id: 'ath-1' });
  });
});

describe('getShadowResearchProjection event-name filter', () => {
  function eventRow(overrides: Partial<{
    shadow_event_id: number;
    event_name: string;
    payload: Record<string, unknown>;
  }>) {
    return {
      shadow_event_id: 1,
      organization_id: 'org-1',
      event_name: 'SHADOW_RESEARCH_NOTE',
      entity_type: 'shadow_library_claim',
      entity_id: 'e-1',
      actor_account_id: 'acct-1',
      actor_role: 'coach',
      payload: {},
      created_at: '2026-08-17T00:00:00.000Z',
      ...overrides,
    };
  }

  test('a Library Q&A knowledge gap (SHADOW_LIBRARY_CLAIM_GAP_DETECTED) is included with its requirement/gap text', async () => {
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([
      eventRow({
        shadow_event_id: 42,
        event_name: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
        payload: {
          research_requirement: 'Strengthen SHADOW Library evidence for scoped claim',
          knowledge_gap: 'Question lacks sufficient SHADOW Library evidence: what is optimal jab cadence?',
        },
      }),
    ]);

    const items = await getShadowResearchProjection(context({}));

    expect(items).toHaveLength(1);
    expect(items[0].source_event_name).toBe('SHADOW_LIBRARY_CLAIM_GAP_DETECTED');
    expect(items[0].knowledge_gap).toBe('Question lacks sufficient SHADOW Library evidence: what is optimal jab cadence?');
  });

  test('an unrelated event with no INTAKE/EVIDENCE/RESEARCH/UPLOAD/GAP token is excluded', async () => {
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([eventRow({ event_name: 'SHADOW_LIBRARY_CLAIM_SUPPORTED' })]);

    const items = await getShadowResearchProjection(context({}));

    expect(items).toHaveLength(0);
  });

  test('a research-panel read by a coach carries the same athlete boundary as the feed under it', async () => {
    // getShadowResearchProjection / getShadowKnowledgeProjection /
    // getShadowObservationProjection / getShadowEventTimeline all read through
    // listShadowEvents, so the boundary must not be re-derivable per panel.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);

    await getShadowResearchProjection(context({ actorRole: 'coach' }));

    expect(mockQuery.mock.calls[1][1][8]).toEqual(['ath-mine']);
    expect(mockQuery.mock.calls[1][1][9]).toBe(true);
  });
});

describe('listShadowAuthorityChecks athlete scoping', () => {
  /**
   * This reader had no scope predicate and no test at all, which is the pair
   * that let it survive: #569 mirrored the athlete access contract across the
   * read models and did not reach it, and nothing failed to say so.
   *
   * It matters because assertShadowAuthority persists its caller's metadata
   * verbatim, and two callers put an athlete id in it -- the medical-status
   * route writes { athlete_id, status, expires_at } on every clearance change,
   * and intake domain-upsert writes { athlete_id } for entity types including
   * `medical`. The sanitizer was no help: every role this route admits is
   * inside roleCanViewSensitivePayload, so the redacting branch never ran.
   */

  test('platform owner reaches no athlete-tied authority row, mirroring its refusal everywhere else', async () => {
    // SHADOW_PHI_ROLES excludes platform_owner deliberately -- "the platform
    // owner tier has no legitimate need for it" -- so the medical-status route
    // answers Omega 403. Before the scope predicate existed it could read the
    // same clearance out of the ledger instead.
    mockQuery.mockResolvedValueOnce([]);
    await listShadowAuthorityChecks(context({ actorRole: 'platform_owner' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[7]).toEqual([]);
    expect(params[8]).toBe(true);
  });

  test('a coach is scoped to their own roster, not every athlete in the organization', async () => {
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);

    await listShadowAuthorityChecks(context({ actorRole: 'coach', actorAccountId: 'coach-1' }));

    const params = mockQuery.mock.calls[1][1];
    expect(params[7]).toEqual(['ath-mine']);
    expect(params[8]).toBe(true);
  });

  test('an organization admin remains unrestricted', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowAuthorityChecks(context({ actorRole: 'organization_admin' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[7]).toBeNull();
    expect(params[8]).toBe(true);
  });

  test('the boundary keeps the athlete list and the athlete-free rows as separate disjuncts', async () => {
    // Most authority rows name no athlete -- every upload, every review action,
    // and every refusal recorded before assertShadowAuthority throws. Scoping on
    // the first disjunct alone would empty the governance console for the coaches
    // and admins it exists for, which is the regression #569 measured on the
    // sibling readers.
    mockQuery.mockResolvedValueOnce([]);
    await listShadowAuthorityChecks(context({ actorRole: 'platform_owner' }));

    const sql = sqlOf(0);
    expect(sql).toContain("$8::text[] is null or metadata->>'athlete_id' = any($8::text[])");
    expect(sql).toContain("$9::boolean");
  });

  test('treats a row as athlete-free only when no metadata key names an athlete', async () => {
    // Stricter than an athlete_id-is-null test on purpose: a blob naming an
    // athlete through entity_type/entity_id or owner_entity_id is athlete-tied
    // whether or not it also carries athlete_id, and the athlete-free disjunct
    // would hand it straight back to the roles the first disjunct excluded.
    mockQuery.mockResolvedValueOnce([]);
    await listShadowAuthorityChecks(context({ actorRole: 'platform_owner' }));

    const sql = sqlOf(0);
    expect(sql).toContain("metadata->>'entity_id' = any($8::text[])");
    expect(sql).toContain("metadata->>'owner_entity_id' = any($8::text[])");
    expect(sql).toContain(
      "or ( $9::boolean and metadata->>'athlete_id' is null and metadata->>'owner_entity_id' is null and metadata->>'entity_type' is distinct from 'athlete' )",
    );
  });
});
