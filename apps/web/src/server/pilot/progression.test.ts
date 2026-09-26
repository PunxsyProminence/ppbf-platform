function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import {
  assignDrill,
  cancelDrillAssignment,
  getAssignmentCompletions,
  getAthleteAssignments,
  getAthleteGaps,
  getCompletionById,
  getDrillAssignmentById,
  recordCompletion,
  verifyCompletion,
} from './progression';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('assignDrill', () => {
  // W-D3, OD-2026-09-18-001. These cases pin the WRITER-level half of the
  // invariant. The route has its own checks; these prove a caller that skips
  // the route still cannot write an unanchored or unassignable row. Whether the
  // SQL actually refuses those rows against a real database is proven in
  // coachCards.pg.test.ts and drillsPersistence.pg.test.ts -- a mocked client
  // can only show what the writer ASKS for.
  const base = {
    organizationId: 'org-1',
    gapId: 'gap-1',
    athleteId: 'ath-1',
    assignedByAccountId: 'coach-1',
    drillId: 'drill-jab',
  };

  test('writes the assignment and closes out the gap in one transaction', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    const assignment = await assignDrill(base);

    // Both writes go through the transaction client, so a failure between them
    // cannot leave a drill assigned against a gap still marked 'identified'.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(currentClient.query).toHaveBeenCalledTimes(2);
    expect(currentClient.query.mock.calls[0][0]).toContain('insert into pilot.drill_assignments');

    const [updateSql, updateParams] = currentClient.query.mock.calls[1];
    expect(updateSql).toContain('update pilot.progression_gaps');
    expect(updateParams).toEqual(['gap-1', 'org-1']);

    expect(assignment).toEqual({ assignment_id: 'asg-1' });
  });

  test('inserts FROM an active operational drill in the same org, snapshotting its name and focus', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    await assignDrill(base);

    const [insertSql, insertParams] = currentClient.query.mock.calls[0];
    // The row is selected out of pilot.drills, so the drill is resolved and the
    // wording snapshotted in the same statement that writes it.
    expect(insertSql).toMatch(/from pilot\.drills d\s+where d\.organization_id = \$2 and d\.drill_id = \$3 and d\.active/);
    expect(insertSql).toContain('d.name, d.focus');
    // Never the reference library -- which is why a drl_ id cannot be assigned.
    expect(insertSql).not.toContain('drill_library');
    expect(insertParams[1]).toBe('org-1');
    expect(insertParams[2]).toBe('drill-jab');
  });

  test.each([
    ['progression.ts', 'assignDrill'],
    ['coachCards.ts', 'issueCoachCard'],
    ['coachCards.ts', 'issueCoachCardToProgram'],
  ])('THE FIXTURE FIREWALL: %s %s never reads reference_drill_id', (file, fn) => {
    // A new-assignment writer that selected reference_drill_id -- directly, or
    // by reusing DRILL_FIELDS or getDrill() -- would fail every real-Postgres
    // suite that builds pilot.drills without the provenance migration, exactly
    // how W-D1's CI went red. Asserted on the source, so it covers all three
    // writers, including paths no mocked case below exercises.
    const source = jest.requireActual<typeof import('fs')>('fs').readFileSync(
      jest.requireActual<typeof import('path')>('path').join(__dirname, file),
      'utf8',
    );
    const start = source.indexOf(`export async function ${fn}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).not.toMatch(/reference_drill_id|DRILL_FIELDS|getDrill\(/);
    // And it does read the drill -- a writer that stopped reading pilot.drills
    // would pass the line above for the wrong reason.
    expect(body).toContain('from pilot.drills d');
  });

  test('carries no caller-supplied drill wording -- there is no parameter for it', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    await assignDrill(base);

    // Eleven parameters: id, org, drill, gap, athlete, assigner, difficulty,
    // reps, duration, frequency, due date. None of them is a name or a
    // description, because those come from the drill.
    const [, insertParams] = currentClient.query.mock.calls[0];
    expect(insertParams).toHaveLength(11);
  });

  test('an explicit difficulty overrides the drill; an absent one lets the drill decide', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ assignment_id: 'asg-1' }] });

    await assignDrill({ ...base, drillDifficulty: 'advanced' });
    expect(currentClient.query.mock.calls[0][1][6]).toBe('advanced');

    currentClient.query.mockClear();
    await assignDrill(base);
    // null, so `coalesce($7, d.difficulty)` falls through to the drill's own.
    expect(currentClient.query.mock.calls[0][1][6]).toBeNull();
    expect(currentClient.query.mock.calls[0][0]).toContain('coalesce($7::text, d.difficulty)');
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a number', 42],
  ])('refuses a drillId that is %s, before touching the database', async (_label, drillId) => {
    await expect(
      assignDrill({ ...base, drillId: drillId as unknown as string }),
    ).rejects.toMatchObject({ status: 400, code: 'DRILL_ID_REQUIRED' });
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test('a drill that selects nothing -- unknown, foreign, retired or a reference id -- is refused, and the gap is left alone', async () => {
    // The INSERT ... SELECT found no active drill in this gym, so it inserted
    // nothing. The writer must throw rather than return undefined, and must
    // throw BEFORE the gap update, so the rollback leaves the gap as it was.
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(assignDrill({ ...base, drillId: 'drl_3c2aad1eb8baa9' })).rejects.toMatchObject({
      status: 400,
      code: 'DRILL_NOT_ASSIGNABLE',
    });
    expect(currentClient.query).toHaveBeenCalledTimes(1);
    expect(currentClient.query.mock.calls[0][0]).not.toContain('update pilot.progression_gaps');
  });
});

describe('getAthleteAssignments', () => {
  // A renamed drill must not rewrite history: the stored drill_name stays in
  // the projection next to the drill's current name.
  test('carries the typed record and the drill as it stands now', async () => {
    await getAthleteAssignments('org-1', 'ath-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('a.drill_name');
    expect(sql).toContain('coalesce(d.name, a.drill_name) as drill_display_name');
    expect(sql).toContain("coalesce(nullif(d.focus, ''), a.drill_description) as drill_display_description");
  });

  // A scalar join on drill_id alone would reach another gym's drill.
  test('joins the drill inside the organization boundary', async () => {
    await getAthleteAssignments('org-1', 'ath-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('left join pilot.drills d');
    expect(sql).toContain('d.organization_id = a.organization_id and d.drill_id = a.drill_id');
  });
});

describe('getAssignmentCompletions', () => {
  // The athlete's progression page renders "Verified on <date>" from
  // verified_at; without the column in the projection that line could never
  // appear, however many completions a coach had verified.
  test('returns the verification timestamp the progression page renders', async () => {
    await getAssignmentCompletions('org-1', 'asg-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('verified_at');
  });
});

describe('getAthleteGaps', () => {
  // 'medium' > 'critical' alphabetically, so ordering on the raw text column
  // listed the least severe gaps first.
  test('ranks severity explicitly rather than sorting the text column', async () => {
    await getAthleteGaps('org-1', 'ath-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('order by severity desc');
    expect(sql).toContain("when 'critical' then 1");
    expect(sql).toContain("when 'low' then 4");
  });
});

// OPERATIONS V1 acceptance point 37: a Coach Card is a drill_assignments row,
// so "a card id from another gym is useless" is exactly "this lookup is
// org-scoped". Both ids below travel to the client on every write, and both
// are the only thing standing between a caller and another gym's record on
// the completions route -- that route authorizes on what these two return,
// and a row they hand back is a row it will act on. verifyCompletion below
// already shipped with an unscoped fallback once (#214); these are the same
// class of hole in the two lookups that feed it.
describe('the id lookups the card and completion routes authorize on', () => {
  test('getDrillAssignmentById is scoped by organization, so another gym\'s assignment id reads as absent', async () => {
    await getDrillAssignmentById('org-1', 'assignment-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('a.organization_id = $1');
    expect(sql).toContain('a.assignment_id = $2');
    expect(params).toEqual(['org-1', 'assignment-1']);
  });

  test('getDrillAssignmentById never matches on the assignment id alone', async () => {
    await getDrillAssignmentById('org-1', 'assignment-1');

    const [sql] = mockQueryOne.mock.calls[0];
    expect(sql).not.toMatch(/where\s+a\.assignment_id\s*=\s*\$1/i);
  });

  test('getCompletionById is scoped the same way, before any verification flips', async () => {
    await getCompletionById('org-1', 'completion-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('completion_id = $2');
    expect(params).toEqual(['org-1', 'completion-1']);
  });
});

describe('verifyCompletion', () => {
  // organizationId was briefly optional, with a fallback that updated by
  // completion_id alone. A completion_id is not a secret, so that path let a
  // caller in one gym flip a record in another. These pin the scope shut.
  test('scopes the update by organization, not by completion id alone', async () => {
    await verifyCompletion('c-1', 'coach-1', true, 'org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $5');
    expect(params).toContain('org-1');
  });

  test('never issues an update that matches on completion_id alone', async () => {
    await verifyCompletion('c-1', 'coach-1', false, 'org-1');

    // The unscoped statement was a single line ending at the completion id.
    // If it ever comes back, this fails rather than waiting for a breach.
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/where\s+completion_id\s*=\s*\$4\s*(returning|$)/i);
  });

  // A completion in another gym must be indistinguishable from one that does
  // not exist, so a probe cannot enumerate another gym's records by comparing
  // "not found" against "not yours".
  test('returns null when no row matched, so the route can hide the difference', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(verifyCompletion('c-other-gym', 'coach-1', true, 'org-1')).resolves.toBeNull();
  });
});

// A-FIN-06, owner decisions 2026-09-22. The WRITER-level half of cancelling:
// which transitions exist, and that a cancel writes the status and nothing
// else. The route's access order is pinned in
// app/api/pilot/progression/assignments/cancel/route.test.ts. A mocked
// database shows what the writer ASKS for; the concurrency claim (a completion
// committing first makes the conditional update match nothing) is Postgres's
// READ COMMITTED re-check, not something a mock can prove.
describe('cancelDrillAssignment', () => {
  const params = { organizationId: 'org-1', assignmentId: 'asg-1', athleteId: 'ath-1' };
  const row = (status: string, overrides: Record<string, unknown> = {}) => ({
    assignment_id: 'asg-1',
    athlete_id: 'ath-1',
    status,
    rep_count: 30,
    due_date: '2026-10-01',
    ...overrides,
  });

  test('open work: one conditional update, and the updated row comes back', async () => {
    mockQuery.mockResolvedValueOnce([row('cancelled')]);

    await expect(cancelDrillAssignment(params)).resolves.toEqual({
      assignment: row('cancelled'),
      alreadyCancelled: false,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Nothing to explain, so no re-read.
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('the update sets status alone, and only open work in this gym, for this athlete, can match it', async () => {
    mockQuery.mockResolvedValueOnce([row('cancelled')]);

    await cancelDrillAssignment(params);

    const [sql, sqlParams] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/set status = 'cancelled'\s+where organization_id = \$1 and assignment_id = \$2 and athlete_id = \$3\s+and status in \('assigned', 'in_progress'\)/);
    expect(String(sql).match(/\bset\b([\s\S]*?)\bwhere\b/i)?.[1].trim()).toBe("status = 'cancelled'");
    expect(sql).not.toContain('updated_at');
    expect(sql).not.toContain('assignment_completions');
    expect(sqlParams).toEqual(['org-1', 'asg-1', 'ath-1']);
  });

  test('already-cancelled work is a success that writes nothing and returns the row as it stands', async () => {
    const existing = row('cancelled', { completion_percentage: 50 });
    mockQuery.mockResolvedValueOnce([]); // matched nothing: cancelled is not open
    mockQueryOne.mockResolvedValueOnce(existing);

    await expect(cancelDrillAssignment(params)).resolves.toEqual({ assignment: existing, alreadyCancelled: true });
    // The re-read is the organization-scoped reader, by this assignment.
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'asg-1']);
  });

  test.each(['completed', 'incomplete'])('%s work is refused with a 409 naming why', async (status) => {
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(row(status));

    await expect(cancelDrillAssignment(params)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_CLOSED' });
  });

  test("an unknown id, another gym's id and another athlete's work all come back as null", async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    mockQueryOne.mockResolvedValueOnce(null);
    await expect(cancelDrillAssignment(params)).resolves.toBeNull();

    mockQueryOne.mockResolvedValueOnce(row('assigned', { athlete_id: 'ath-2' }));
    await expect(cancelDrillAssignment(params)).resolves.toBeNull();
  });

  test('never opens a transaction: one statement is the whole write', async () => {
    const { withTransaction } = jest.requireMock('./db') as { withTransaction: jest.Mock };
    mockQuery.mockResolvedValueOnce([row('cancelled')]);

    await cancelDrillAssignment(params);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(currentClient.query).not.toHaveBeenCalled();
  });
});

// A-FIN-06, owner decision 2026-09-22: no new completions on cancelled work.
// Checked under a row lock BEFORE the insert, so the check and the write
// cannot be split by a cancel landing in between.
describe('recordCompletion on cancelled work', () => {
  const params = { organizationId: 'org-1', assignmentId: 'asg-1', athleteId: 'ath-1' };

  test('is refused with a 409 before anything is inserted', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ status: 'cancelled' }] });

    await expect(recordCompletion(params)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_CANCELLED' });
    expect(currentClient.query).toHaveBeenCalledTimes(1);
    const [lockSql, lockParams] = currentClient.query.mock.calls[0];
    expect(lockSql).toContain('for update');
    expect(lockSql).not.toContain('insert');
    expect(lockParams).toEqual(['org-1', 'asg-1']);
  });

  test.each(['assigned', 'in_progress', 'completed'])('%s work still takes the log, locked and checked first', async (status) => {
    currentClient.query
      .mockResolvedValueOnce({ rows: [{ status }] }) // lock + status check
      .mockResolvedValueOnce({ rows: [{ completion_id: 'c1' }] }) // insert
      .mockResolvedValueOnce({ rows: [{ frequency_per_week: null, status }] }) // touchAssignmentProgress lock
      .mockResolvedValueOnce({ rows: [{ n: '1' }] }); // count

    await expect(recordCompletion(params)).resolves.toEqual({ completion_id: 'c1' });
    const order = currentClient.query.mock.calls.map(([sql]) => String(sql));
    expect(order[0]).toContain('for update');
    expect(order[1]).toContain('insert into pilot.assignment_completions');
  });
});
