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
  getAssignmentCompletions,
  getAthleteAssignments,
  getAthleteGaps,
  getCompletionById,
  getDrillAssignmentById,
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
  test('writes the assignment and closes out the gap in one transaction', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    const assignment = await assignDrill({
      organizationId: 'org-1',
      gapId: 'gap-1',
      athleteId: 'ath-1',
      assignedByAccountId: 'coach-1',
      drillName: 'Jab discipline',
      drillDescription: 'Three rounds on the bag',
      drillDifficulty: 'intermediate',
    });

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

  // Every assignment written before drills had identity carries only free text,
  // and a coach may still type one out, so the anchor stays nullable.
  test('a typed assignment carries no anchor', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    await assignDrill({
      organizationId: 'org-1',
      gapId: 'gap-1',
      athleteId: 'ath-1',
      assignedByAccountId: 'coach-1',
      drillName: 'Jab discipline',
      drillDescription: 'Three rounds on the bag',
      drillDifficulty: 'intermediate',
    });

    const [, insertParams] = currentClient.query.mock.calls[0];
    expect(insertParams[12]).toBeNull();
  });

  test('a drill picked from the library is stored as the anchor alongside what was typed', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [{ assignment_id: 'asg-1' }] });

    await assignDrill({
      organizationId: 'org-1',
      gapId: 'gap-1',
      athleteId: 'ath-1',
      assignedByAccountId: 'coach-1',
      drillId: 'drill-jab',
      drillName: 'Jab retraction (Tuesday floor)',
      drillDescription: 'Three rounds, focus on the elbow',
      drillDifficulty: 'intermediate',
    });

    const [insertSql, insertParams] = currentClient.query.mock.calls[0];
    expect(insertSql).toContain('drill_id');
    expect(insertParams[12]).toBe('drill-jab');
    // The typed wording is the record of what was assigned that day.
    expect(insertParams[5]).toBe('Jab retraction (Tuesday floor)');
    expect(insertParams[6]).toBe('Three rounds, focus on the elbow');
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
