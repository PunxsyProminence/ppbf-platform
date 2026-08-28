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
  test('a competition writes one column and nulls the other', async () => {
    mockQueryOne.mockResolvedValue({ block_id: 'blk-1' });

    await setDevelopmentBlockTarget('org-1', 'blk-1', { kind: 'competition', id: 'comp-1' });

    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'blk-1', 'comp-1', null]);
  });

  test('a wrestling event writes the other column', async () => {
    mockQueryOne.mockResolvedValue({ block_id: 'blk-1' });

    await setDevelopmentBlockTarget('org-1', 'blk-1', { kind: 'wrestling_event', id: 'evt-1' });

    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'blk-1', null, 'evt-1']);
  });

  test("'none' clears both columns", async () => {
    mockQueryOne.mockResolvedValue({ block_id: 'blk-1' });

    await setDevelopmentBlockTarget('org-1', 'blk-1', { kind: 'none' });

    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'blk-1', null, null]);
  });

  test('a blank id is refused rather than written as an empty target', async () => {
    await expect(setDevelopmentBlockTarget('org-1', 'blk-1', { kind: 'competition', id: '   ' }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('a block in another organization is not found, and nothing is written elsewhere', async () => {
    mockQueryOne.mockResolvedValue(null);

    expect(await setDevelopmentBlockTarget('org-mine', 'blk-elsewhere', { kind: 'none' })).toBeNull();
    expect(mockQueryOne.mock.calls[0][1][0]).toBe('org-mine');
  });

  test('the write touches neither the athlete nor the creator', async () => {
    // A block does not change which child it is about, and who authored it is
    // a fact about the past.
    mockQueryOne.mockResolvedValue({ block_id: 'blk-1' });

    await setDevelopmentBlockTarget('org-1', 'blk-1', { kind: 'competition', id: 'comp-1' });

    const sql = String(mockQueryOne.mock.calls[0][0]);
    const setClause = sql.slice(sql.indexOf('set'), sql.indexOf('where'));
    expect(setClause).not.toMatch(/athlete_id/);
    expect(setClause).not.toMatch(/created_by/);
    expect(setClause).not.toMatch(/organization_id/);
  });
});
