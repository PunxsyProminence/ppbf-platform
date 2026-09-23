import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { POST } from './route';
import * as progressionModule from '@/src/server/pilot/progression';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';
import type { DrillAssignment } from '@/src/server/pilot/progression';

// A-FIN-06, owner decisions 2026-09-22. A coach with access to an athlete can
// cancel that athlete's OPEN work, and nothing else: no edit, no delete, no
// reopen. These cases hold the route's access order and the writer's
// transition rules together, through the real access.ts and the real
// progression.ts over a mocked database -- the same shape as the assignments
// and completions route suites beside this one. What the SQL does against a
// real Postgres (the conditional update racing a completion) is not provable
// with a mock; what IS pinned here is that the statement asks for exactly
// that condition and nothing more.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // Cancelling is one conditional statement and needs no transaction. A
  // transaction opened here would mean something began writing more than the
  // one row, so the fake refuses to run one.
  withTransaction: jest.fn(async () => {
    throw new Error('db tripwire: cancel must not open a transaction');
  }),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

// Typed against the producer, so a fixture cannot invent a key the reader
// never sends. Every field a cancel must leave alone carries a real value, so
// "unchanged" is a claim about something rather than about nulls.
function assignmentRow(overrides: Partial<DrillAssignment> = {}): DrillAssignment {
  return {
    assignment_id: 'asg-1',
    gap_id: 'gap-1',
    athlete_id: 'ath-1',
    drill_id: 'drill-jab',
    drill_name: 'Jab return',
    drill_description: 'Hand home before the next beat.',
    drill_display_name: 'Jab return',
    drill_display_description: 'Hand home before the next beat.',
    drill_category: 'striking',
    drill_cues: ['chin down'],
    drill_difficulty: 'intermediate',
    rep_count: 30,
    duration_minutes: 10,
    frequency_per_week: 3,
    due_date: '2026-10-01',
    status: 'assigned',
    completion_percentage: 33,
    assigned_by_account_id: 'coach-1',
    assigned_at: '2026-09-18T12:00:00.000Z',
    created_at: '2026-09-18T12:00:00.000Z',
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/progression/assignments/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { assignment_id: 'asg-1', athlete_id: 'ath-1' };

/**
 * queryOne order inside the route for a coach: getDrillAssignmentById, then
 * assertCoachAssignedToAthlete (coach of record, then coverage). For an
 * organization admin the second read is assertAthleteBelongsToOrganization.
 */
function coachReaches(assignment: DrillAssignment | null) {
  mockQueryOne
    .mockResolvedValueOnce(assignment) // getDrillAssignmentById
    .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // coach of record
}

/** Every statement sent to the database, in order, as [sql, params]. */
const statements = () => [...mockQuery.mock.calls, ...mockQueryOne.mock.calls].map(([sql, params]) => [String(sql), params]);
const updates = () => mockQuery.mock.calls.filter(([sql]) => /\bupdate\b/i.test(String(sql)));

describe('POST /api/pilot/progression/assignments/cancel -- open work is cancelled', () => {
  test('assigned work becomes cancelled, through one conditional update', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow({ status: 'assigned' }));
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_cancelled).toBe(false);
    expect(body.assignment.status).toBe('cancelled');
    expect(updates()).toHaveLength(1);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('in-progress work becomes cancelled', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow({ status: 'in_progress' }));
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
    expect((await res.json()).assignment.status).toBe('cancelled');
  });

  test('the write is scoped to this gym, this assignment and this athlete, and only open work can match it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow());
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    await POST(postRequest(VALID));

    const [sql, params] = updates()[0];
    expect(sql).toMatch(
      /update pilot\.drill_assignments\s+set status = 'cancelled'\s+where organization_id = \$1 and assignment_id = \$2 and athlete_id = \$3\s+and status in \('assigned', 'in_progress'\)/,
    );
    expect(params).toEqual(['org-1', 'asg-1', 'ath-1']);
  });

  // History preservation (A-FIN-06 rule 3). The SET clause is the whole of
  // what a cancel changes, so it is pinned to exactly one assignment.
  test('only the status column changes: the SET clause names status and nothing else', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow());
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    await POST(postRequest(VALID));

    const [sql] = updates()[0];
    const setClause = String(sql).match(/\bset\b([\s\S]*?)\bwhere\b/i)?.[1] ?? '';
    expect(setClause.trim()).toBe("status = 'cancelled'");
    for (const column of [
      'updated_at', 'rep_count', 'duration_minutes', 'frequency_per_week', 'due_date', 'drill_id',
      'drill_name', 'drill_description', 'drill_difficulty', 'assigned_by_account_id', 'assigned_at',
      'completion_percentage',
    ]) {
      expect(setClause).not.toContain(column);
    }
  });

  test('completions already logged are not touched: no statement names the completions table', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow({ status: 'in_progress' }));
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
    for (const [sql] of statements()) {
      expect(sql).not.toContain('assignment_completions');
      expect(sql).not.toMatch(/\bdelete\b/i);
      expect(sql).not.toMatch(/\binsert\b/i);
    }
  });

  test('the answer carries the row the update returned, through the same projection every read uses', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow());
    const returned = assignmentRow({ status: 'cancelled' });
    mockQuery.mockResolvedValueOnce([returned]);

    const res = await POST(postRequest(VALID));

    expect(await res.json()).toEqual({ assignment: returned, already_cancelled: false });
    const [sql] = updates()[0];
    expect(sql).toContain(progressionModule.ASSIGNMENT_FIELDS);
    expect(sql).toContain('left join pilot.drills d');
  });
});

describe('already-cancelled work: a retry is a success that changes nothing', () => {
  test('returns the existing cancelled assignment exactly as it stands, and says it was already cancelled', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    const existing = assignmentRow({ status: 'cancelled', completion_percentage: 67 });
    coachReaches(existing);
    // The conditional update matches nothing: 'cancelled' is not open work.
    mockQuery.mockResolvedValueOnce([]);
    // The writer's re-read, to say why.
    mockQueryOne.mockResolvedValueOnce(existing);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignment: existing, already_cancelled: true });
    // The only write statement sent could not have matched a cancelled row,
    // and nothing else was written.
    expect(updates()).toHaveLength(1);
    expect(String(updates()[0][0])).toContain("and status in ('assigned', 'in_progress')");
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});

describe('closed work cannot be cancelled', () => {
  test.each([
    ['completed', 'This work is already completed, so it cannot be cancelled.'],
    ['incomplete', 'This work is already closed as incomplete, so it cannot be cancelled.'],
  ] as const)('%s work is refused with a 409 and a plain sentence', async (status, message) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    const closed = assignmentRow({ status, completion_percentage: 100 });
    coachReaches(closed);
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(closed);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message, code: 'ASSIGNMENT_CLOSED' });
  });

  test('work a completion closes between the route read and the write is refused, not overwritten', async () => {
    // The route read it as in progress; by the time the update ran, the
    // athlete's last log had completed it, so the conditional update matched
    // nothing. The re-read says why, and the completion stands.
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow({ status: 'in_progress' }));
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ status: 'completed', completion_percentage: 100 }));

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ASSIGNMENT_CLOSED');
  });
});

describe('the assignment is resolved inside the caller gym, for the athlete named', () => {
  test('a mismatched athlete_id fails closed, as not found, before anything is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-2' }));

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQuery).not.toHaveBeenCalled();
    // Refused before the access check: the other athlete is not even asked about.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  // The test above is refused twice over: by the mismatch, and by this coach
  // having no access to ath-2. Here the coach IS ath-2's coach of record, so
  // the mismatch check alone stands between the request and a write.
  describe('even when the caller can reach the athlete the work really belongs to', () => {
    afterEach(() => {
      // The access read and the update are queued only for a route that skips
      // the mismatch check; a correct route never consumes them, and a
      // leftover queued answer must not leak into the next test.
      mockQueryOne.mockReset();
      mockQuery.mockReset();
    });

    test('a mismatched athlete_id still fails closed, as not found, and nothing is written', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockQueryOne
        .mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-2' })) // getDrillAssignmentById
        .mockResolvedValueOnce({ athlete_id: 'ath-2' }); // coach of record for ath-2
      mockQuery.mockResolvedValueOnce([assignmentRow({ athlete_id: 'ath-2', status: 'cancelled' })]);

      const res = await POST(postRequest(VALID)); // names ath-1

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  test("another gym's assignment id reads as absent: same answer as an id that does not exist", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    // getDrillAssignmentById is scoped by the SESSION's organization, so the
    // other gym's row is simply not found.
    mockQueryOne.mockResolvedValueOnce(null);

    const foreign = await POST(postRequest({ ...VALID, assignment_id: 'asg-other-gym' }));

    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(null);
    const unknown = await POST(postRequest({ ...VALID, assignment_id: 'asg-does-not-exist' }));

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(mockQuery).not.toHaveBeenCalled();
    const [lookupSql, lookupParams] = mockQueryOne.mock.calls[0];
    expect(lookupSql).toContain('a.organization_id = $1');
    expect(lookupParams).toEqual(['org-1', 'asg-other-gym']);
  });

  test('an organization_id in the body is never read: the gym is the session gym', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow());
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest({ ...VALID, organization_id: 'org-other' }));

    expect(res.status).toBe(200);
    for (const [, params] of statements()) {
      expect(params).not.toContain('org-other');
    }
    expect(updates()[0][1][0]).toBe('org-1');
  });
});

describe('who may cancel: coaches with access and organization admins (owner decision)', () => {
  test.each<PilotRole>(['athlete', 'parent', 'platform_owner', 'board', 'volunteer'])(
    'the %s role is refused before any record is read',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(
        principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null }),
      );

      const res = await POST(postRequest(VALID));

      expect(res.status).toBe(403);
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  test('the athlete whose work it is cannot cancel it either', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1', accountId: 'ath-acct-1' }));

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a coach with no relationship to the athlete is refused as not found, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-stranger' }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow()) // getDrillAssignmentById
      .mockResolvedValueOnce(null) // not the coach of record
      .mockResolvedValueOnce(null); // and no live coverage grant

    const res = await POST(postRequest(VALID));

    // The same answer an unknown id gets, so a coach in the same gym cannot
    // use this route to learn which assignment ids exist for athletes they
    // cannot reach.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a covering coach with a live coverage grant can cancel', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-covering' }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(null) // not the coach of record
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live coverage
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
  });

  test.each<PilotRole>(['organization_admin', 'admin'])('an %s in the same gym can cancel', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, accountId: 'admin-1' }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertAthleteBelongsToOrganization
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(200);
  });

  test('a failed access check is a server error, not a quiet "not found"', async () => {
    // Folding every failure into 404 would tell a coach the work does not
    // exist when the truth is that nobody could check.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockQuery).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  test('401 when there is no session', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await POST(postRequest(VALID));

    expect(res.status).toBe(401);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('a request that names nothing is refused before any read', () => {
  test.each([
    ['no assignment_id', { athlete_id: 'ath-1' }],
    ['no athlete_id', { assignment_id: 'asg-1' }],
    ['an empty assignment_id', { assignment_id: '', athlete_id: 'ath-1' }],
    ['a whitespace athlete_id', { assignment_id: 'asg-1', athlete_id: '   ' }],
    ['a numeric assignment_id', { assignment_id: 7, athlete_id: 'ath-1' }],
    ['an object athlete_id', { assignment_id: 'asg-1', athlete_id: { id: 'ath-1' } }],
  ])('%s -> 400', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(postRequest(body));

    expect(res.status).toBe(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a body that is not JSON is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(postRequest('not json'));

    expect(res.status).toBe(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

// Owner decision: cancel only. These pin that the slice did not also grow an
// edit, a delete or a way back.
describe('cancel is the only capability this adds', () => {
  test('the route answers POST and no other verb', () => {
    const exported = Object.keys(routeModule).filter(
      (key) => typeof (routeModule as Record<string, unknown>)[key] === 'function',
    );
    expect(exported).toEqual(['POST']);
    for (const verb of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect((routeModule as Record<string, unknown>)[verb]).toBeUndefined();
    }
  });

  test('the progression module exports no edit, delete, undo or reopen writer for assignments', () => {
    const writers = Object.keys(progressionModule).filter((name) =>
      /(edit|update|delete|remove|undo|reopen|restore|uncancel)\w*assignment/i.test(name),
    );
    expect(writers).toEqual([]);
  });

  test('no statement a cancel sends can move work back to open', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    coachReaches(assignmentRow());
    mockQuery.mockResolvedValueOnce([assignmentRow({ status: 'cancelled' })]);

    await POST(postRequest(VALID));

    for (const [sql] of updates()) {
      expect(String(sql)).not.toMatch(/set\s+status\s*=\s*'(assigned|in_progress)'/);
    }
  });
});
