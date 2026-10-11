// issueCoachCard's optional transaction client (lane P7, #1401).
//
// Issuing a workout template writes one card per step in ONE transaction, so
// the insert can ride a caller's client. Without one it must be exactly the
// pooled insert it was. Everything else about cards -- the access boundary, the
// group issuance, the reads -- is proven against real PostgreSQL in
// coachCards.pg.test.ts, and that a rollback leaves no card is proven in
// workoutTemplateIssue.pg.test.ts.

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

import { issueCoachCard } from './coachCards';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const PARAMS = {
  organizationId: 'org-1',
  athleteId: 'athlete-1',
  assignedByAccountId: 'coach-1',
  drillId: 'drill-1',
  repCount: 20,
  durationMinutes: 6,
};

const CARD = { assignment_id: 'assignment_1', gap_id: null, athlete_id: 'athlete-1', drill_id: 'drill-1' };

// $1 is a fresh assignment id on every call; every other value is the caller's.
const valuesWithoutId = (values: unknown[]) => values.slice(1);

afterEach(() => {
  jest.clearAllMocks();
});

describe('issueCoachCard: the optional transaction client', () => {
  test('with no client it is the pooled insert-from-the-drill, with a null gap', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);

    await expect(issueCoachCard(PARAMS)).resolves.toEqual(CARD);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, values] = mockQuery.mock.calls[0];
    expect(text).toContain('insert into pilot.drill_assignments');
    expect(text).toContain('from pilot.drills d');
    expect(text).toContain('where d.organization_id = $2 and d.drill_id = $3 and d.active');
    expect(valuesWithoutId(values)).toEqual(['org-1', 'drill-1', 'athlete-1', 'coach-1', null, 20, 6, null, null]);
  });

  test('with a client the SAME statement and values go to that client, and the pool writes nothing', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);
    await issueCoachCard(PARAMS);
    const [pooledText, pooledValues] = mockQuery.mock.calls[0];
    mockQuery.mockClear();

    const client = { query: jest.fn(async () => ({ rows: [{ ...CARD, assignment_id: 'on-the-transaction' }] })) };
    const card = await issueCoachCard(PARAMS, client as never);

    expect(card.assignment_id).toBe('on-the-transaction');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    const [text, values] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toBe(pooledText);
    expect(valuesWithoutId(values)).toEqual(valuesWithoutId(pooledValues));
  });

  test('the cue-rule read runs before the insert on both paths, and stays pooled', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);
    await issueCoachCard(PARAMS);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'drill-1']);

    const client = { query: jest.fn(async () => ({ rows: [CARD] })) };
    await issueCoachCard(PARAMS, client as never);
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    expect(mockQueryOne.mock.invocationCallOrder[1]).toBeLessThan(client.query.mock.invocationCallOrder[0]);
  });

  test('a drill that selects nothing is refused on the client path exactly as on the pooled one', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })) };

    await expect(issueCoachCard(PARAMS, client as never)).rejects.toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });
    await expect(issueCoachCard(PARAMS)).rejects.toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });
  });
});
