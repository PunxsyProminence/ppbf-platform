/*
 * The mapping half of the competition target, which the database cannot hold.
 *
 * athleteDevelopmentBlockCompetitionTarget.pg.test.ts proves the rules that
 * ARE the database's -- the composite foreign keys, the single-target check,
 * idempotency. What is left here is the reading: how a stored row becomes the
 * five things a coach is shown, and what "sanctioning body where stored"
 * actually means when one table has the column and the other does not.
 */
import { query, queryOne } from './db';
import {
  listDevelopmentBlockTargetOptions,
  resolveDevelopmentBlockTarget,
  setDevelopmentBlockTarget,
} from './athleteDevelopmentBlockTargets';
import { ValidationError } from './errors';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const NO_TARGET = { target_competition_id: null, target_wrestling_event_id: null };

describe('resolving what a block is preparing for', () => {
  test('a block naming nothing resolves to null without touching the database', async () => {
    expect(await resolveDevelopmentBlockTarget('org-1', NO_TARGET)).toBeNull();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('a competition resolves to a name, a date, a place and a body', async () => {
    mockQueryOne.mockResolvedValue({
      competition_id: 'comp-1',
      competition_name: 'Keystone Open',
      competition_date: '2026-11-14',
      location: 'Altoona, PA',
      sanctioning_body: 'USA Boxing',
      status: 'planned',
    });

    const target = await resolveDevelopmentBlockTarget('org-1', {
      target_competition_id: 'comp-1',
      target_wrestling_event_id: null,
    });

    expect(target).toEqual({
      kind: 'competition',
      id: 'comp-1',
      name: 'Keystone Open',
      date: '2026-11-14',
      location: 'Altoona, PA',
      sanctioning_body: 'USA Boxing',
      status: 'planned',
    });
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'comp-1']);
  });

  test("an unrecorded sanctioning body reads as null, never as a body named ''", async () => {
    // The column is NOT NULL DEFAULT '', so an empty string means nobody
    // recorded one. Passing it through would put an empty field on screen
    // where "we do not know" is the truth.
    mockQueryOne.mockResolvedValue({
      competition_id: 'comp-1',
      competition_name: 'Club Show',
      competition_date: '2026-11-14',
      location: '',
      sanctioning_body: '   ',
      status: 'planned',
    });

    const target = await resolveDevelopmentBlockTarget('org-1', {
      target_competition_id: 'comp-1',
      target_wrestling_event_id: null,
    });

    expect(target?.sanctioning_body).toBeNull();
  });

  test('a wrestling event resolves with no sanctioning body at all', async () => {
    // pilot.wrestling_league_events HAS NO SUCH COLUMN. That is a schema fact,
    // not a gap to fill in.
    mockQueryOne.mockResolvedValue({
      event_id: 'evt-1',
      event_name: 'Punxsutawney Duals',
      event_date: '2026-12-06',
      location: 'Punxsutawney, PA',
      status: 'planned',
    });

    const target = await resolveDevelopmentBlockTarget('org-1', {
      target_competition_id: null,
      target_wrestling_event_id: 'evt-1',
    });

    expect(target).toEqual({
      kind: 'wrestling_event',
      id: 'evt-1',
      name: 'Punxsutawney Duals',
      date: '2026-12-06',
      location: 'Punxsutawney, PA',
      sanctioning_body: null,
      status: 'planned',
    });
  });

  test('a cancelled event resolves and says it is cancelled', async () => {
    mockQueryOne.mockResolvedValue({
      competition_id: 'comp-1',
      competition_name: 'Keystone Open',
      competition_date: '2026-11-14',
      location: 'Altoona, PA',
      sanctioning_body: 'USA Boxing',
      status: 'cancelled',
    });

    const target = await resolveDevelopmentBlockTarget('org-1', {
      target_competition_id: 'comp-1',
      target_wrestling_event_id: null,
    });

    expect(target?.status).toBe('cancelled');
  });

  test('a row that cannot be read resolves to null rather than a fabricated event', async () => {
    mockQueryOne.mockResolvedValue(null);

    expect(await resolveDevelopmentBlockTarget('org-1', {
      target_competition_id: 'comp-1',
      target_wrestling_event_id: null,
    })).toBeNull();
  });

  test('the read is scoped to the organization it was given', async () => {
    mockQueryOne.mockResolvedValue(null);

    await resolveDevelopmentBlockTarget('org-mine', {
      target_competition_id: 'comp-1',
      target_wrestling_event_id: null,
    });

    expect(mockQueryOne.mock.calls[0][1][0]).toBe('org-mine');
  });
});

describe('the picker of possible targets', () => {
  test('competitions and league events arrive as one list, newest date first', async () => {
    mockQuery
      .mockResolvedValueOnce([{
        competition_id: 'comp-1',
        competition_name: 'Keystone Open',
        competition_date: '2026-11-14',
        location: 'Altoona, PA',
        sanctioning_body: 'USA Boxing',
        status: 'planned',
      }])
      .mockResolvedValueOnce([{
        event_id: 'evt-1',
        event_name: 'Punxsutawney Duals',
        event_date: '2026-12-06',
        location: 'Punxsutawney, PA',
        status: 'planned',
      }]);

    const options = await listDevelopmentBlockTargetOptions('org-1');

    expect(options.map((option) => option.id)).toEqual(['evt-1', 'comp-1']);
    expect(options.map((option) => option.kind)).toEqual(['wrestling_event', 'competition']);
  });

  test('both reads are scoped to the organization', async () => {
    mockQuery.mockResolvedValue([]);

    await listDevelopmentBlockTargetOptions('org-mine');

    for (const call of mockQuery.mock.calls) {
      expect(call[1]).toEqual(['org-mine']);
    }
  });

  test('cancelled fixtures are offered, marked, not hidden', async () => {
    // A coach whose target was called off has to see it in order to change it.
    mockQuery
      .mockResolvedValueOnce([{
        competition_id: 'comp-1',
        competition_name: 'Keystone Open',
        competition_date: '2026-11-14',
        location: '',
        sanctioning_body: '',
        status: 'cancelled',
      }])
      .mockResolvedValueOnce([]);

    const options = await listDevelopmentBlockTargetOptions('org-1');

    expect(options).toHaveLength(1);
    expect(options[0].status).toBe('cancelled');
    expect(options[0].sanctioning_body).toBeNull();
  });
});

describe('setting and clearing a target', () => {
  /* setDevelopmentBlockTarget now delegates to updateDevelopmentBlock rather
     than issuing its own UPDATE, so what is asserted here is the delegation
     and the ONE-statement property it buys. The two used to be separate
     writes, and a target that failed its foreign key left the field changes
     committed while the caller was told the request failed (review, #771). */
  const blockRow = {
    organization_id: 'org-1',
    block_id: 'blk-1',
    athlete_id: 'ath-1',
    title: 'Autumn block',
    training_emphasis: 'Guard recovery.',
    starts_on: '2026-09-01',
    ends_on: '2026-11-10',
    status: 'draft',
    target_competition_id: null,
    target_wrestling_event_id: null,
    created_by_account_id: 'acct-coach',
    created_at: 'x',
    updated_at: 'x',
  };

  /* setDevelopmentBlockTarget takes an actor now, not an organization id --
     #762 moved the athlete-access gate into the data layer. These cases are
     about the target mapping and the one-statement property, so the actor is
     a coach in the fixture's own organization: the gate is exercised for real
     (nothing here mocks './access'), it simply passes. */
  const COACH = {
    accountId: 'acct-coach',
    role: 'coach' as const,
    organizationId: 'org-1',
    athleteId: null,
  };

  /** queryOne is called twice by the real update: the read-back, then the
   *  write. This returns the row for both. */
  function stubRow() {
    mockQueryOne.mockResolvedValue({ ...blockRow });
  }

  /** The UPDATE, as opposed to the getDevelopmentBlock read before it. */
  function writeCall() {
    return mockQueryOne.mock.calls.find((call) => String(call[0]).includes('update pilot.athlete_development_blocks'));
  }

  test('a competition writes one column and nulls the other, in one statement', async () => {
    stubRow();

    await setDevelopmentBlockTarget(COACH, 'blk-1', { kind: 'competition', id: 'comp-1' });

    const write = writeCall();
    expect(write).toBeDefined();
    expect(write?.[1]).toEqual(expect.arrayContaining(['comp-1']));
    expect(String(write?.[0])).toMatch(/target_competition_id = \$8/);
    expect(String(write?.[0])).toMatch(/target_wrestling_event_id = \$9/);
    // One UPDATE, not two: fields and target move together or not at all.
    const updates = mockQueryOne.mock.calls.filter((call) =>
      String(call[0]).includes('update pilot.athlete_development_blocks'));
    expect(updates).toHaveLength(1);
  });

  test('a wrestling event writes the other column', async () => {
    stubRow();

    await setDevelopmentBlockTarget(COACH, 'blk-1', { kind: 'wrestling_event', id: 'evt-1' });

    const params = writeCall()?.[1] as unknown[];
    expect(params[7]).toBeNull();
    expect(params[8]).toBe('evt-1');
  });

  test("'none' clears both columns", async () => {
    stubRow();

    await setDevelopmentBlockTarget(COACH, 'blk-1', { kind: 'none' });

    const params = writeCall()?.[1] as unknown[];
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });

  test('a blank id is refused, and nothing is written at all', async () => {
    // Refused before the UPDATE, so the block's own fields do not move either.
    mockQueryOne.mockResolvedValue({ ...blockRow });

    await expect(setDevelopmentBlockTarget(COACH, 'blk-1', { kind: 'competition', id: '   ' }))
      .rejects.toBeInstanceOf(ValidationError);

    expect(writeCall()).toBeUndefined();
  });

  test('a block in another organization is not found, and nothing is written', async () => {
    /* Two stubs, in order, because updateDevelopmentBlock asks two questions
       now: may this account write blocks in this organization, and does this
       block exist within reach. Stubbing every queryOne to null would answer
       the FIRST one -- and the test would pass on a ForbiddenError about
       membership while claiming to be about a block in another gym. The
       membership passes here so the not-found answer is the one under test. */
    mockQueryOne
      .mockResolvedValueOnce({ account_id: 'acct-coach' })
      .mockResolvedValueOnce(null);

    expect(await setDevelopmentBlockTarget({ ...COACH, organizationId: 'org-mine' }, 'blk-elsewhere', { kind: 'none' })).toBeNull();
    expect(writeCall()).toBeUndefined();
  });

  test('the write touches neither the athlete nor the creator', async () => {
    stubRow();

    await setDevelopmentBlockTarget(COACH, 'blk-1', { kind: 'competition', id: 'comp-1' });

    const sql = String(writeCall()?.[0]);
    const setClause = sql.slice(sql.indexOf('set'), sql.indexOf('where'));
    expect(setClause).not.toMatch(/athlete_id/);
    expect(setClause).not.toMatch(/created_by/);
    expect(setClause).not.toMatch(/organization_id/);
  });
});
