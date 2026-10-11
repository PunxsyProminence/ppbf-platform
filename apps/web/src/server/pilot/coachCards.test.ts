// issueCoachCard's optional transaction client (lane P7, #1401).
//
// Issuing a workout template writes one card per step in ONE transaction, so
// the insert -- and the cue-rule read in front of it -- can ride a caller's
// client. Without one, both must be exactly the pooled statements they were.
// Everything else about cards -- the access boundary, the group issuance, the
// reads -- is proven against real PostgreSQL in coachCards.pg.test.ts, and
// that a rollback leaves no card is proven in workoutTemplateIssue.pg.test.ts.

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

const isInsert = (text: string) => text.includes('insert into pilot.drill_assignments');
const isCueRead = (text: string) => text.includes("to_jsonb(d) ->> 'reference_drill_id'");
const isReferenceRead = (text: string) => text.includes('from pilot.drill_library');

/**
 * A transaction client. `drill` is the row the cue-rule read finds (null: the
 * drill is not visible, and the insert is left to refuse it); `discipline` is
 * the reference's, read only for a cue-less adopted drill.
 */
function transactionClient(opts: { drill?: Record<string, unknown> | null; discipline?: string; card?: object | null } = {}) {
  const drill = opts.drill === undefined ? { name: 'Jab', category: 'technical', cues: ['Turn the fist'], reference_drill_id: null } : opts.drill;
  const card = opts.card === undefined ? CARD : opts.card;
  return {
    // Typed with both arguments so the cases below can read the values a
    // statement was called with, though the fake itself routes on the text.
    query: jest.fn<Promise<{ rows: object[] }>, [string, unknown[]]>(async (text) => {
      if (isCueRead(text)) return { rows: drill ? [drill] : [] };
      if (isReferenceRead(text)) return { rows: opts.discipline ? [{ discipline: opts.discipline }] : [] };
      if (isInsert(text)) return { rows: card ? [card] : [] };
      throw new Error(`test bug: unexpected statement on the client: ${text}`);
    }),
  };
}

const statements = (client: { query: jest.Mock }) => client.query.mock.calls.map(([text]) => text as string);

// $1 is a fresh assignment id on every call; every other value is the caller's.
const valuesWithoutId = (values: unknown[]) => values.slice(1);

afterEach(() => {
  jest.clearAllMocks();
});

describe('issueCoachCard with no client: the pooled statements it always was', () => {
  test('one pooled cue-rule read with exactly (text, [org, drill]), then one pooled insert-from-the-drill with a null gap', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);

    await expect(issueCoachCard(PARAMS)).resolves.toEqual(CARD);

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0]).toHaveLength(2);
    expect(isCueRead(mockQueryOne.mock.calls[0][0])).toBe(true);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'drill-1']);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, values] = mockQuery.mock.calls[0];
    expect(text).toContain('insert into pilot.drill_assignments');
    expect(text).toContain('from pilot.drills d');
    expect(text).toContain('where d.organization_id = $2 and d.drill_id = $3 and d.active');
    expect(valuesWithoutId(values)).toEqual(['org-1', 'drill-1', 'athlete-1', 'coach-1', null, 20, 6, null, null]);
    expect(mockQueryOne.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[0]);
  });

  test('a cue-less technique drill is refused before the insert, and a cue-less adopted drill reads its reference from the pool', async () => {
    mockQueryOne.mockResolvedValueOnce({ name: 'Jab', category: 'technical', cues: [], reference_drill_id: null });
    await expect(issueCoachCard(PARAMS)).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED' });
    expect(mockQuery).not.toHaveBeenCalled();

    mockQueryOne
      .mockResolvedValueOnce({ name: 'Sled Push', category: 'strength', cues: [], reference_drill_id: 'drl_ref' })
      .mockResolvedValueOnce({ discipline: 'conditioning' });
    mockQuery.mockResolvedValueOnce([CARD]);
    await expect(issueCoachCard(PARAMS)).resolves.toEqual(CARD);
    expect(isReferenceRead(mockQueryOne.mock.calls[2][0])).toBe(true);
    expect(mockQueryOne.mock.calls[2][1]).toEqual(['org-1', 'drl_ref']);
  });

  test('a drill that selects nothing is refused', async () => {
    await expect(issueCoachCard(PARAMS)).rejects.toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });
  });
});

describe("issueCoachCard with a client: everything rides the caller's transaction", () => {
  test('the SAME insert statement and values go to the client', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);
    await issueCoachCard(PARAMS);
    const [pooledText, pooledValues] = mockQuery.mock.calls[0];
    jest.clearAllMocks();

    const client = transactionClient({ card: { ...CARD, assignment_id: 'on-the-transaction' } });
    const card = await issueCoachCard(PARAMS, client as never);

    expect(card.assignment_id).toBe('on-the-transaction');
    const insert = client.query.mock.calls.find(([text]) => isInsert(text)) as [string, unknown[]];
    expect(insert[0]).toBe(pooledText);
    expect(valuesWithoutId(insert[1])).toEqual(valuesWithoutId(pooledValues));
  });

  test('NO pooled read or write happens: the cue-rule read is on the client too, with the same statement and values, before the insert', async () => {
    mockQuery.mockResolvedValueOnce([CARD]);
    await issueCoachCard(PARAMS);
    const [pooledCueText, pooledCueValues] = mockQueryOne.mock.calls[0];
    jest.clearAllMocks();

    const client = transactionClient();
    await issueCoachCard(PARAMS, client as never);

    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(statements(client).map((text) => (isCueRead(text) ? 'cue' : isInsert(text) ? 'insert' : 'other'))).toEqual(['cue', 'insert']);
    expect(client.query.mock.calls[0][0]).toBe(pooledCueText);
    expect(client.query.mock.calls[0][1]).toEqual(pooledCueValues);
  });

  test('the rule is ENFORCED on the client: a cue-less technique drill the transaction can see is refused, and nothing is inserted', async () => {
    const client = transactionClient({ drill: { name: 'Jab', category: 'technical', cues: [], reference_drill_id: null } });

    await expect(issueCoachCard(PARAMS, client as never)).rejects.toMatchObject({
      code: 'DRILL_CUE_REQUIRED',
      status: 409,
    });

    expect(statements(client).some(isInsert)).toBe(false);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test("a cue-less adopted drill reads its reference's discipline on the client, never the pool", async () => {
    const conditioning = transactionClient({
      drill: { name: 'Sled Push', category: 'strength', cues: [], reference_drill_id: 'drl_ref' },
      discipline: 'conditioning',
    });
    await expect(issueCoachCard(PARAMS, conditioning as never)).resolves.toEqual(CARD);
    const referenceRead = conditioning.query.mock.calls.find(([text]) => isReferenceRead(text)) as [string, unknown[]];
    expect(referenceRead[1]).toEqual(['org-1', 'drl_ref']);

    const technique = transactionClient({
      drill: { name: 'Slip Line', category: 'technical', cues: [], reference_drill_id: 'drl_ref' },
      discipline: 'boxing',
    });
    await expect(issueCoachCard(PARAMS, technique as never)).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED' });

    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a drill that selects nothing is refused on the client path exactly as on the pooled one', async () => {
    const client = transactionClient({ drill: null, card: null });

    await expect(issueCoachCard(PARAMS, client as never)).rejects.toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });
  });
});
