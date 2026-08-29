/**
 * HOW MANY STATEMENTS A WRITE COSTS, held to a number.
 *
 * Each of the three write paths in coachDevelopment.ts used to insert or
 * update with `returning <id>` and then SELECT the row back. That is a second
 * round trip for a row the first statement already had, and a window: between
 * the two, what came back was not provably what had just been written. Two
 * tabs correcting the same goal, or one double submit, and the caller was
 * handed a later row than the one it wrote and told that was its result.
 *
 * The behaviour tests for these paths live in coachDevelopment.pg.test.ts and
 * run against a real database. They pass under EITHER shape -- one statement
 * or two -- because both end up returning the same row in the single-writer
 * case a test creates. So they cannot hold this. This file does, by counting
 * the statements and reading them, against a mocked db.
 *
 * It asserts the SHAPE OF THE WRITE, not the behaviour of the row. It is
 * deliberately paired with the pg suite rather than replacing any part of it:
 * a mocked db proves nothing about what Postgres does with the SQL.
 */

import {
  createCoachDevelopmentActivity,
  createCoachDevelopmentGoal,
  updateCoachDevelopmentGoal,
} from './coachDevelopment';
import { queryOne } from './db';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;

const ORG = '11111111-1111-1111-1111-111111111111';
const COACH = '22222222-2222-2222-2222-222222222222';
const GOAL = '33333333-3333-3333-3333-333333333333';

const MEMBERSHIP_ROW = { account_id: COACH };

const GOAL_ROW = {
  organization_id: ORG,
  goal_id: GOAL,
  coach_account_id: COACH,
  title: 'Corner work',
  development_focus: 'Reading a round faster than I do now',
  target_on: null,
  status: 'draft' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const ACTIVITY_ROW = {
  organization_id: ORG,
  activity_id: '44444444-4444-4444-4444-444444444444',
  coach_account_id: COACH,
  goal_id: null,
  title: 'Youth coaching clinic',
  provider: '',
  occurred_on: '2026-01-05',
  duration_minutes: null,
  notes: '',
  created_at: '2026-01-05T00:00:00.000Z',
  updated_at: '2026-01-05T00:00:00.000Z',
};

afterEach(() => {
  jest.clearAllMocks();
});

/** Every SQL string the module sent, in order, whitespace-collapsed. */
function statements(): string[] {
  return mockQueryOne.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}

/* A write costs the membership check plus ONE statement. The membership check
   is a separate read on purpose -- it decides whether the write may happen at
   all, and folding it into the insert would mean attempting the write first --
   so it is counted here rather than eliminated. */

describe('recording a goal', () => {
  test('writes with one statement, and that statement returns the row', async () => {
    mockQueryOne
      .mockResolvedValueOnce(MEMBERSHIP_ROW)
      .mockResolvedValueOnce(GOAL_ROW);

    const created = await createCoachDevelopmentGoal({
      organizationId: ORG,
      coachAccountId: COACH,
      title: 'Corner work',
      developmentFocus: 'Reading a round faster than I do now',
    });

    expect(created).toEqual(GOAL_ROW);

    const sql = statements();
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('from pilot.organization_memberships');
    expect(sql[1]).toContain('insert into pilot.coach_development_goals');

    // The insert names its columns back. `returning goal_id` -- the shape this
    // replaced -- would satisfy neither of these.
    expect(sql[1]).toContain('returning organization_id, goal_id');
    expect(sql[1]).toContain('development_focus');

    // And there is no SELECT after it.
    expect(sql.filter((statement) => statement.startsWith('select'))).toHaveLength(1);
  });

  test('an insert that reports no row is raised, not returned as a not-found', async () => {
    mockQueryOne
      .mockResolvedValueOnce(MEMBERSHIP_ROW)
      .mockResolvedValueOnce(null);

    await expect(createCoachDevelopmentGoal({
      organizationId: ORG,
      coachAccountId: COACH,
      title: 'Corner work',
      developmentFocus: 'Reading a round faster than I do now',
    })).rejects.toThrow('COACH_DEVELOPMENT_GOAL_NOT_RETURNED');
  });
});

describe('recording development work', () => {
  test('writes with one statement, and that statement returns the row', async () => {
    mockQueryOne
      .mockResolvedValueOnce(MEMBERSHIP_ROW)
      .mockResolvedValueOnce(ACTIVITY_ROW);

    const created = await createCoachDevelopmentActivity({
      organizationId: ORG,
      coachAccountId: COACH,
      title: 'Youth coaching clinic',
      occurredOn: '2026-01-05',
    });

    expect(created).toEqual(ACTIVITY_ROW);

    const sql = statements();
    expect(sql).toHaveLength(2);
    expect(sql[1]).toContain('insert into pilot.coach_development_activities');
    expect(sql[1]).toContain('returning organization_id, activity_id');
    expect(sql[1]).toContain('duration_minutes');
    expect(sql.filter((statement) => statement.startsWith('select'))).toHaveLength(1);
  });
});

describe('correcting a goal', () => {
  test('reads the existing row once, then updates with one statement that returns it', async () => {
    mockQueryOne
      .mockResolvedValueOnce(GOAL_ROW)
      .mockResolvedValueOnce({ ...GOAL_ROW, status: 'active' });

    const updated = await updateCoachDevelopmentGoal(ORG, COACH, GOAL, { status: 'active' });

    expect(updated).toEqual({ ...GOAL_ROW, status: 'active' });

    const sql = statements();
    /* The read BEFORE the update is load-bearing and stays: it is what makes
       a colleague's goal a hidden not-found, and what the merged-row
       validation is run against. The read AFTER it is the one that went. */
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('select');
    expect(sql[0]).toContain('from pilot.coach_development_goals');
    expect(sql[1]).toContain('update pilot.coach_development_goals');
    expect(sql[1]).toContain('returning organization_id, goal_id');
    expect(sql[1]).toContain('updated_at');
  });

  test('a goal that is not this coach\'s is not updated at all', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    expect(await updateCoachDevelopmentGoal(ORG, COACH, GOAL, { status: 'active' })).toBeNull();
    expect(statements()).toHaveLength(1);
  });
});
