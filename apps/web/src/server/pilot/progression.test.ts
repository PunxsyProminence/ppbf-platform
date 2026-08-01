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
} from './progression';
import { query } from './db';

const mockQuery = query as jest.Mock;

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
