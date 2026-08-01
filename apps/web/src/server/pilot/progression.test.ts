function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { assignDrill, getAssignmentCompletions, getAthleteGaps } from './progression';
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
