import { query, queryOne } from './db';
import { listShadowEvents, listShadowTelemetry, listShadowAuthorityChecks, getShadowReviewProjection, getShadowResearchProjection, getShadowKnowledgeProjection } from './shadowReadModels';
import type { ShadowReadContext } from './shadowReadModels';
import type { PilotRole } from './contracts';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
// Only the athlete arm uses it: the live-row read behind accessibleAthleteIds.
const mockQueryOne = queryOne as jest.Mock;

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
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // their live row
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'athlete', athleteId: 'ath-1' }));

    // The live-row read, in the actor's own gym.
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'ath-1']);
    expect(String(mockQueryOne.mock.calls[0][0])).toContain('deleted_at is null');

    const params = mockQuery.mock.calls[0][1];
    const restrictToAthleteIds = params[8];
    const includeUnscopedRows = params[9];
    expect(restrictToAthleteIds).toEqual(['ath-1']);
    expect(includeUnscopedRows).toBe(false);
  });

  test('a deleted athlete (no live row) gets a scope that matches nothing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'athlete', athleteId: 'ath-1' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[8]).toEqual(['__unbound_athlete__']);
    expect(params[9]).toBe(false);
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

    // Which athletes a row names is computed over the whole payload (audit
    // CL-A1/CL-C6); shadowEventAthleteScope.pg.test.ts proves the rows each
    // role reads on a real Postgres. Pinned here: both disjuncts survive, the
    // athlete-tied one demands EVERY named athlete, and the athlete-free one
    // refuses a row that merely mentions an athlete.
    const sql = sqlOf(1);
    expect(sql).toContain("strict $.**");
    expect(sql).toContain("e.payload");
    expect(sql).toContain(
      '$9::text[] is null or (cardinality(tie.athlete_ids) > 0 and tie.athlete_ids <@ $9::text[] and not tie.unresolved_athlete) or ($10::boolean and cardinality(tie.athlete_ids) = 0 and not tie.mentions_athlete and not tie.unresolved_athlete)',
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

  test('a coach is scoped to their roster, and to the unattributed cases they filed themselves', async () => {
    // CL-A10: the unattributed half used to admit every coach to every case
    // with no athlete yet. It is now the case gate's own rule: the coach who
    // filed it, bound as the actor.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'coach', actorAccountId: 'coach-1' }));

    const itemsParams = mockQuery.mock.calls[1][1];
    const totalParams = mockQuery.mock.calls[2][1];
    expect(itemsParams[5]).toEqual(['ath-mine']);
    expect(itemsParams[6]).toBe(true);
    expect(itemsParams[7]).toBe('coach-1');
    expect(totalParams[3]).toEqual(['ath-mine']);
    expect(totalParams[4]).toBe(true);
    expect(totalParams[5]).toBe('coach-1');
  });

  test('the items query and the count query carry the identical boundary', async () => {
    // Different predicates here mean the caller pages through one set of rows
    // against another set's total.
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce([{ count: '0' }]);

    await getShadowReviewProjection(context({ actorRole: 'coach' }));

    // CL-A10: every athlete the case names must be in reach (not just the
    // column), and an unattributed case only reaches the account that filed it.
    expect(sqlOf(1)).toContain(
      "$6::text[] is null or ( cardinality(subj.athlete_ids) > 0 and subj.athlete_ids <@ $6::text[] ) or ( cardinality(subj.athlete_ids) = 0 and $7::boolean and c.submitted_by_account_id = $8::text )",
    );
    expect(sqlOf(2)).toContain(
      "$4::text[] is null or ( cardinality(subj.athlete_ids) > 0 and subj.athlete_ids <@ $4::text[] ) or ( cardinality(subj.athlete_ids) = 0 and $5::boolean and c.submitted_by_account_id = $6::text )",
    );
    // Both read the document owners, not the column alone.
    for (const call of [1, 2]) {
      expect(sqlOf(call)).toContain("owner_doc.owner_entity_type = 'athlete'");
      expect(sqlOf(call)).not.toContain('c.primary_athlete_id is null)');
    }
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

describe('actor_account_id in the events feed (staff only)', () => {
  // The payload sanitizer never touched the row's own columns, so every
  // non-staff caller of listShadowEvents received the staff account id that
  // wrote the event (intake lane review, 2026-10-06). The account id is the
  // actor identifier; actor_role is a label, not an identity, and the SQL
  // tie relies on it, so it stays.
  function staffWrittenRow() {
    return {
      shadow_event_id: 7,
      organization_id: 'org-1',
      event_name: 'SHADOW_INTAKE_DOCUMENT_ROUTED',
      entity_type: 'intake_case',
      entity_id: 'case-1',
      actor_account_id: 'coach-acct-secret',
      actor_role: 'coach',
      payload: { intake_case_id: 'case-1', routed_queue: 'coach_review' },
      created_at: '2026-10-06T00:00:00.000Z',
    };
  }

  test.each<PilotRole>(['parent', 'athlete', 'volunteer'])('%s gets null actor_account_id', async (actorRole) => {
    if (actorRole === 'athlete') {
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    }
    if (actorRole === 'parent') {
      mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }]); // guardian_links
    }
    mockQuery.mockResolvedValueOnce([staffWrittenRow()]);

    const rows = await listShadowEvents(context({ actorRole, athleteId: actorRole === 'athlete' ? 'ath-1' : null }));

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_account_id).toBeNull();
    expect(rows[0].actor_role).toBe('coach');
    expect(rows[0].payload).toEqual({ intake_case_id: 'case-1', routed_queue: 'coach_review' });
  });

  test.each<PilotRole>(['coach', 'organization_admin'])('%s still gets actor_account_id', async (actorRole) => {
    if (actorRole === 'coach') {
      answerCoachRoster([]);
    }
    mockQuery.mockResolvedValueOnce([staffWrittenRow()]);

    const rows = await listShadowEvents(context({ actorRole }));

    expect(rows[0].actor_account_id).toBe('coach-acct-secret');
  });
});

describe('Library question text in the events feed (CL-A3, staff only)', () => {
  // Jason 2026-10-06, CL-A3 "Staff only": Library research questions are for
  // coaches and org admins. platform_owner is not staff and gets no
  // org-private access by default -- yet it reads unscoped rows and, through
  // roleCanViewSensitivePayload, the whole payload, and a claim-gap payload's
  // knowledge_gap quotes the question a member typed.
  const QUESTION = 'Question lacks sufficient SHADOW Library evidence: my son keeps getting headaches after sparring, is that normal?. Evidence count: 0. Distinct sources: 0.';

  function claimGapRow() {
    return {
      shadow_event_id: 7,
      organization_id: 'org-1',
      event_name: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
      entity_type: 'shadow_library_claim',
      entity_id: 'scoped:1759700000000',
      actor_account_id: 'acct-parent',
      actor_role: 'parent',
      payload: {
        scope: 'scoped',
        subject_id: null,
        status: 'unsupported',
        evidence_count: 0,
        confidence_level: 'none',
        distinct_source_count: 0,
        research_requirement_id: 'rr-1',
        research_requirement: 'Strengthen SHADOW Library evidence for scoped claim',
        knowledge_gap: QUESTION,
        question: 'my son keeps getting headaches after sparring, is that normal?',
      },
      created_at: '2026-10-06T00:00:00.000Z',
    };
  }

  test('platform_owner gets the claim-gap event without the question text, operational fields intact', async () => {
    mockQuery.mockResolvedValueOnce([claimGapRow()]);

    const rows = await listShadowEvents(context({ actorRole: 'platform_owner' }));

    expect(rows).toHaveLength(1);
    expect(rows[0].event_name).toBe('SHADOW_LIBRARY_CLAIM_GAP_DETECTED');
    expect(rows[0].payload).not.toHaveProperty('knowledge_gap');
    expect(rows[0].payload).not.toHaveProperty('question');
    expect(JSON.stringify(rows[0].payload)).not.toContain('headaches');
    expect(rows[0].payload).toEqual({
      scope: 'scoped',
      subject_id: null,
      status: 'unsupported',
      evidence_count: 0,
      confidence_level: 'none',
      distinct_source_count: 0,
      research_requirement_id: 'rr-1',
      research_requirement: 'Strengthen SHADOW Library evidence for scoped claim',
    });
  });

  test('platform_owner gets the allowlist on SHADOW_LIBRARY_CLAIM_SUPPORTED too', async () => {
    const row = { ...claimGapRow(), event_name: 'SHADOW_LIBRARY_CLAIM_SUPPORTED' };
    row.payload = { ...row.payload, status: 'supported', question_excerpt: 'headaches after sparring' } as typeof row.payload;
    mockQuery.mockResolvedValueOnce([row]);

    const rows = await listShadowEvents(context({ actorRole: 'platform_owner' }));

    expect(JSON.stringify(rows[0].payload)).not.toContain('headaches');
    expect(rows[0].payload.status).toBe('supported');
  });

  test('platform_owner research panel keeps the gap item but not the question', async () => {
    mockQuery.mockResolvedValueOnce([claimGapRow()]);

    const items = await getShadowResearchProjection(context({ actorRole: 'platform_owner' }));

    expect(items).toHaveLength(1);
    expect(items[0].source_event_name).toBe('SHADOW_LIBRARY_CLAIM_GAP_DETECTED');
    expect(items[0].requirement).toBe('Strengthen SHADOW Library evidence for scoped claim');
    expect(items[0].knowledge_gap).toBeNull();
  });

  // Every role, typed as a Record so a role added to PilotRole fails to compile
  // here until someone decides which side of the ruling it is on.
  const READS_LIBRARY_QUESTIONS: Record<PilotRole, boolean> = {
    coach: true,
    organization_admin: true,
    admin: true,
    platform_owner: false,
    staff: false,
    volunteer: false,
    board: false,
    parent: false,
    athlete: false,
  };
  const OPERATIONAL_KEYS = [
    'scope',
    'subject_id',
    'status',
    'evidence_count',
    'confidence_level',
    'distinct_source_count',
    'research_requirement_id',
    'research_requirement',
  ];

  test.each(Object.entries(READS_LIBRARY_QUESTIONS) as [PilotRole, boolean][])(
    '%s: reads the question text on a Library claim event = %s',
    async (actorRole, readsQuestions) => {
      // The roles whose scope is resolved by a lookup answer it first (empty):
      // a coach's roster, a parent's guardian links. The row is fed to the
      // mocked events query either way -- this pins the payload filter, not
      // the row scope above it.
      if (actorRole === 'coach' || actorRole === 'parent') {
        mockQuery.mockResolvedValueOnce([]);
      }
      mockQuery.mockResolvedValueOnce([claimGapRow()]);

      const rows = await listShadowEvents(context({ actorRole }));

      if (readsQuestions) {
        expect(rows[0].payload.knowledge_gap).toBe(QUESTION);
        expect(rows[0].payload.question).toBeDefined();
      } else {
        expect(JSON.stringify(rows[0].payload)).not.toContain('headaches');
        for (const key of Object.keys(rows[0].payload)) {
          expect(OPERATIONAL_KEYS).toContain(key);
        }
      }
    },
  );

  test('platform_owner gets only operational keys on a Library claim event, so a key added later cannot carry the question', async () => {
    const row = claimGapRow();
    row.payload = { ...row.payload, question_excerpt: 'headaches after sparring', detail: { text: 'headaches' } } as typeof row.payload;
    mockQuery.mockResolvedValueOnce([row]);

    const rows = await listShadowEvents(context({ actorRole: 'platform_owner' }));

    expect(JSON.stringify(rows[0].payload)).not.toContain('headaches');
  });

  test('platform_owner keeps the full payload of non-Library events (operational visibility unchanged)', async () => {
    mockQuery.mockResolvedValueOnce([
      { ...claimGapRow(), event_name: 'SHADOW_JOB_FAILED', entity_type: 'shadow_job', payload: { job_id: 'j-1', error: 'timeout' } },
    ]);

    const rows = await listShadowEvents(context({ actorRole: 'platform_owner' }));

    expect(rows[0].payload).toEqual({ job_id: 'j-1', error: 'timeout' });
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

describe('getShadowKnowledgeProjection stream placement', () => {
  function intakeEvent(eventName: string) {
    return {
      shadow_event_id: 1,
      organization_id: 'org-1',
      event_name: eventName,
      entity_type: 'intake_case',
      entity_id: 'case-1',
      actor_account_id: 'acct-1',
      actor_role: 'coach',
      payload: {},
      created_at: '2026-08-17T00:00:00.000Z',
    };
  }

  // A reviewer approving or promoting an intake case accepts the observation;
  // nothing has validated it as a lesson. It used to be filed under
  // 'Validated Lesson' on its review state alone, a label every member read.
  test.each([
    ['SHADOW_INTAKE_CASE_APPROVED', 'approved'],
    ['SHADOW_INTAKE_CASE_PROMOTED', 'promoted'],
  ])('%s stays an Observation, carrying its review outcome as %s', async (eventName, reviewState) => {
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([intakeEvent(eventName)]);

    const items = await getShadowKnowledgeProjection(context({}));

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('Observation');
    expect(items[0].review_state).toBe(reviewState);
  });

  test('nothing an event name can say puts it in the Validated Lesson stream', async () => {
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([
      intakeEvent('SHADOW_INTAKE_CASE_APPROVED'),
      intakeEvent('SHADOW_INTAKE_CASE_PROMOTED'),
      intakeEvent('SHADOW_INTAKE_CASE_PENDING'),
      intakeEvent('SHADOW_PATTERN_DETECTED'),
      intakeEvent('SHADOW_FINDING_RECORDED'),
    ]);

    const items = await getShadowKnowledgeProjection(context({}));

    expect(items.map((item) => item.type)).toEqual([
      'Observation', 'Observation', 'Observation', 'Pattern', 'Finding',
    ]);
  });
});

// Audit CL-C24. limit and offset arrive from a JSON body and were clamped but
// not rounded, so 2.5 reached Postgres as a bigint bind and the caller got a
// 500. Every number bound into these reads must be a whole number.
describe('paging values are whole numbers before they reach SQL (CL-C24)', () => {
  const readers: Array<[string, (filters: { limit?: number; offset?: number }) => Promise<unknown>]> = [
    ['listShadowEvents', (filters) => listShadowEvents(context({ actorRole: 'organization_admin' }), filters)],
    ['listShadowTelemetry', (filters) => listShadowTelemetry(context({ actorRole: 'organization_admin' }), filters)],
    ['listShadowAuthorityChecks', (filters) => listShadowAuthorityChecks(context({ actorRole: 'organization_admin' }), filters)],
    ['getShadowReviewProjection', (filters) => getShadowReviewProjection(context({ actorRole: 'organization_admin' }), filters)],
  ];

  test.each(readers)('%s floors a fractional limit and offset', async (_name, read) => {
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue({ total: 0 });

    await read({ limit: 2.5, offset: 1.5 });

    const numbers = (mockQuery.mock.calls[0][1] as unknown[]).filter((value) => typeof value === 'number');
    expect(numbers).toEqual(expect.arrayContaining([2, 1]));
    expect(numbers.every((value) => Number.isInteger(value))).toBe(true);
  });

  test.each(readers)('%s still reads at least one row for a limit under 1', async (_name, read) => {
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue({ total: 0 });

    await read({ limit: 0.4, offset: 0.9 });

    const numbers = (mockQuery.mock.calls[0][1] as unknown[]).filter((value) => typeof value === 'number');
    expect(numbers).toEqual(expect.arrayContaining([1, 0]));
    expect(numbers.every((value) => Number.isInteger(value))).toBe(true);
  });
});
