import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // recordCompletion inserts the log and recomputes assignment percentage in
  // one transaction. The fake hands the callback a client whose query() is the
  // same spy, so call assertions stay meaningful.
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

beforeEach(() => {
  // A transaction client returns the pg Result shape ({ rows }), unlike the
  // module's query() which returns the rows array directly.
  mockWithTransaction.mockImplementation(
    (work: (client: { query: jest.Mock }) => Promise<unknown>) =>
      work({
        query: jest.fn(async (...args: unknown[]) => ({
          rows: (await mockQuery(...args)) ?? [],
        })) as jest.Mock,
      }),
  );
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: 'asg-1',
  gap_id: 'gap-1',
  athlete_id: 'ath-1',
  drill_name: 'drill',
  drill_description: 'desc',
  drill_difficulty: 'intermediate',
  rep_count: null,
  duration_minutes: null,
  frequency_per_week: null,
  due_date: null,
  status: 'assigned',
  completion_percentage: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/progression/completions${query_ ? `?${query_}` : ''}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/progression/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/progression/completions', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot view completions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(403);
  });

  test('linked parent can view completions for their athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // guardian link found
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(200);
  });

  test('unlinked parent gets hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(null); // no guardian link
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('400 when assignment_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await GET(getRequest());
    expect(res.status).toBe(400);
  });

  test('nonexistent assignment returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('assignment_id=does-not-exist'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('cross-athlete access (unassigned coach) returns the same hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }))
      .mockResolvedValueOnce(null);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('athlete can view completions for their own assignment', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow());
    mockQuery.mockResolvedValueOnce([{ completion_id: 'c1' }]);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(200);
  });

  test('assigned coach can view completions', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('assignment_id=asg-1'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pilot/progression/completions', () => {
  test('403 when athlete records a completion for another athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('rejects when the assignment does not belong to the specified athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }));
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(400);
  });

  test('athlete can record their own completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow());
    // recordCompletion transaction: lock + status check → insert → lock
    // assignment → count → update %
    mockQuery
      .mockResolvedValueOnce([{ status: 'assigned' }])
      .mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-1', verification_status: 'pending' }])
      .mockResolvedValueOnce([{ frequency_per_week: null, status: 'assigned' }])
      .mockResolvedValueOnce([{ n: '1' }])
      .mockResolvedValueOnce([]);
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(201);
    expect((await res.json()).completion_id).toBe('c1');
  });

  test('403 when an unassigned coach tries to verify a completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-other', verify: true, verified: true }));
    expect(res.status).toBe(403);
  });

  test('assigned coach can record and verify a completion', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(assignmentRow()); // getDrillAssignmentById
    mockQuery
      .mockResolvedValueOnce([{ status: 'assigned' }]) // lock + status check, before the insert
      .mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-1', verification_status: 'pending' }]) // insert
      .mockResolvedValueOnce([{ frequency_per_week: null, status: 'assigned' }]) // lock assignment
      .mockResolvedValueOnce([{ n: '1' }]) // count
      .mockResolvedValueOnce([]) // update percentage
      .mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-1', verification_status: 'verified' }]); // verifyCompletion
    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1', verify: true, verified: true }));
    expect(res.status).toBe(201);
  });

  test('assigned coach can verify an existing pending completion without creating a new log', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQuery
      .mockResolvedValueOnce([
        { completion_id: 'c1', assignment_id: 'asg-1', athlete_id: 'ath-1' },
      ]) // getCompletionById ownership check, before any write
      .mockResolvedValueOnce([
        {
          completion_id: 'c1',
          assignment_id: 'asg-1',
          completed_at: '2026-01-02T00:00:00.000Z',
          reps_completed: 10,
          notes: 'felt good',
          verification_status: 'verified',
          verified_at: '2026-01-02T01:00:00.000Z',
        },
      ]); // verifyCompletion update returning
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertCoachAssignedToAthlete
    const res = await POST(
      postRequest({ completion_id: 'c1', athlete_id: 'ath-1', verify: true, verified: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verification_status).toBe('verified');
  });

  test("a completion belonging to a different athlete is refused before any write", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    // The completion exists in this organization, but it is ath-other's. The
    // old order flipped verification_status first and 404'd after; the row
    // must now come back untouched, so no update statement may run at all.
    mockQuery.mockResolvedValueOnce([
      { completion_id: 'c1', assignment_id: 'asg-2', athlete_id: 'ath-other' },
    ]); // getCompletionById ownership check
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertCoachAssignedToAthlete
    const res = await POST(
      postRequest({ completion_id: 'c1', athlete_id: 'ath-1', verify: true, verified: true }),
    );
    expect(res.status).toBe(404);
    const updates = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('update'));
    expect(updates).toHaveLength(0);
  });
});

// A-FIN-06, owner decision 2026-09-22: "the athlete can't log new completions
// on cancelled work", and completions already logged stay as history. Before
// this, the record branch wrote a completion whatever the assignment's status
// -- only touchAssignmentProgress skipped cancelled work, AFTER the log was in.
describe('POST /api/pilot/progression/completions -- no new logs on cancelled work', () => {
  const inserts = () => mockQuery.mock.calls.filter(([sql]) => /insert into pilot\.assignment_completions/.test(String(sql)));

  test('an athlete cannot log a completion against cancelled work, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ status: 'cancelled' }));

    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1', notes: 'did it anyway' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This work was cancelled, so a new completion cannot be logged against it. Completions already logged are kept.',
      code: 'ASSIGNMENT_CANCELLED',
    });
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a coach cannot record-and-verify a new completion on cancelled work either', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(assignmentRow({ status: 'cancelled' })); // getDrillAssignmentById

    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1', verify: true, verified: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ASSIGNMENT_CANCELLED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('work cancelled after the route read it is still refused, by the writer, before its insert', async () => {
    // The route saw open work; a coach's cancel committed before the
    // transaction locked the row. The writer's own locked read is what
    // catches it, and it throws before the insert, so the rollback leaves
    // nothing behind.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ status: 'in_progress' }));
    mockQuery.mockResolvedValueOnce([{ status: 'cancelled' }]); // lock + status check

    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ASSIGNMENT_CANCELLED');
    expect(inserts()).toHaveLength(0);
    const [lockSql, lockParams] = mockQuery.mock.calls[0];
    expect(String(lockSql)).toMatch(/from pilot\.drill_assignments\s+where organization_id = \$1 and assignment_id = \$2\s+for update/);
    expect(lockParams).toEqual(['org-1', 'asg-1']);
  });

  test('open work still takes a new completion, and the status is checked under the lock before the insert', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(assignmentRow({ status: 'in_progress' }));
    mockQuery
      .mockResolvedValueOnce([{ status: 'in_progress' }]) // lock + status check
      .mockResolvedValueOnce([{ completion_id: 'c2', assignment_id: 'asg-1', verification_status: 'pending' }]) // insert
      .mockResolvedValueOnce([{ frequency_per_week: 4, status: 'in_progress' }]) // lock assignment
      .mockResolvedValueOnce([{ n: '2' }]) // count
      .mockResolvedValueOnce([]); // update percentage

    const res = await POST(postRequest({ assignment_id: 'asg-1', athlete_id: 'ath-1' }));

    expect(res.status).toBe(201);
    const order = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(order[0]).toContain('for update');
    expect(order[1]).toContain('insert into pilot.assignment_completions');
    expect(inserts()).toHaveLength(1);
  });

  test('verifying or disputing a completion already logged on cancelled work is unchanged: it never asks about the work', async () => {
    // Those logs are the cancelled work's history, and a coach still reviews
    // them. The verify branch reads the completion and flips it; it does not
    // read the assignment's status at all, so cancelling cannot block it.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQuery
      .mockResolvedValueOnce([{ completion_id: 'c1', assignment_id: 'asg-cancelled', athlete_id: 'ath-1' }]) // getCompletionById
      .mockResolvedValueOnce([
        {
          completion_id: 'c1',
          assignment_id: 'asg-cancelled',
          completed_at: '2026-09-20T00:00:00.000Z',
          reps_completed: 12,
          notes: 'before it was cancelled',
          verification_status: 'disputed',
          verified_at: '2026-09-22T01:00:00.000Z',
        },
      ]); // verifyCompletion
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertCoachAssignedToAthlete

    const res = await POST(postRequest({ completion_id: 'c1', athlete_id: 'ath-1', verify: true, verified: false }));

    expect(res.status).toBe(200);
    expect((await res.json()).verification_status).toBe('disputed');
    const everySql = [...mockQuery.mock.calls, ...mockQueryOne.mock.calls].map(([sql]) => String(sql));
    expect(everySql.some((sql) => sql.includes('pilot.drill_assignments'))).toBe(false);
    expect(inserts()).toHaveLength(0);
  });
});
