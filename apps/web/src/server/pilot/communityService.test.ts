// Community service totals (module 128). What these pin: verified and
// unverified minutes NEVER merge into one number (an external reader --
// a school, a court, a scholarship -- needs the verified figure alone);
// hours floor rather than round, so the record never hands out minutes it
// cannot back; only community_service rows are read; and (route survey
// 2026-10-07, B1) a coach receives only the people whose athlete record
// they reach, decided by access.ts, while an organization admin receives
// the whole gym. The SQL side of the reach rule (coach of record, live
// covering coach) is proven against a real database in
// communityServiceReach.pg.test.ts; here access.ts is mocked and the
// module's use of its answer is what is under test.

import { getCommunityServiceTotals, wholeHours } from './communityService';
import { accessibleAthleteIds, type ActorIdentity } from './access';
import { listActivityLog } from './activityLog';
import { query } from './db';

jest.mock('./activityLog', () => ({ listActivityLog: jest.fn() }));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./access', () => ({
  ...jest.requireActual('./access'),
  accessibleAthleteIds: jest.fn(),
}));

const mockList = listActivityLog as jest.Mock;
const mockQuery = query as jest.Mock;
const mockReach = accessibleAthleteIds as jest.Mock;

const ADMIN: ActorIdentity = { accountId: 'acct-admin', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
const COACH: ActorIdentity = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

beforeEach(() => {
  // Default: no login maps to an athlete and nobody is reachable; tests that
  // need either set it. Reset, not just cleared, so no test inherits the
  // previous test's answer by order.
  mockQuery.mockReset().mockResolvedValue([]);
  mockReach.mockReset().mockResolvedValue(new Set());
});

afterEach(() => {
  jest.clearAllMocks();
});

const row = (overrides: Record<string, unknown>) => ({
  organization_id: 'org-1',
  activity_id: 'a-1',
  person_account_id: 'acct-1',
  athlete_id: null,
  activity_domain: 'community_service',
  activity_type: 'food_bank',
  occurred_on: '2026-08-10',
  started_at: null,
  duration_minutes: 60,
  what_was_worked_on: 'sorting donations',
  class_id: null,
  attendance_status: 'present',
  capture_method: 'supervisor_entry',
  recorded_by_role: 'admin',
  recorded_by_account_id: 'acct-admin',
  verified_by_account_id: null,
  verified_at: null,
  rpe: null,
  notes: '',
  created_at: '2026-08-10T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

test('verified and unverified minutes are counted separately and never summed into one figure', async () => {
  mockList.mockResolvedValue([
    row({ activity_id: 'a-1', duration_minutes: 120, verified_by_account_id: 'acct-admin', verified_at: '2026-08-11T00:00:00.000Z' }),
    row({ activity_id: 'a-2', duration_minutes: 90 }),
    row({ activity_id: 'a-3', duration_minutes: 30, verified_by_account_id: 'acct-admin', verified_at: '2026-08-12T00:00:00.000Z' }),
  ]);

  const [totals] = await getCommunityServiceTotals(ADMIN);
  expect(totals.verified_minutes).toBe(150);
  expect(totals.unverified_minutes).toBe(90);
  expect(totals.entry_count).toBe(3);
  // There is deliberately no combined total field to hand out by mistake.
  expect(totals).not.toHaveProperty('total_minutes');
  expect(totals.entries.find((entry) => entry.activity_id === 'a-2')?.verified).toBe(false);
});

test('only the community_service domain is read, in the actor organization', async () => {
  mockList.mockResolvedValue([]);
  await getCommunityServiceTotals(ADMIN, { since: '2026-01-01' });
  expect(mockList).toHaveBeenCalledWith('org-1', expect.objectContaining({
    activityDomain: 'community_service',
    since: '2026-01-01',
  }));
});

test('people are grouped, most service first', async () => {
  mockList.mockResolvedValue([
    row({ activity_id: 'a-1', person_account_id: 'acct-small', duration_minutes: 30 }),
    row({ activity_id: 'a-2', person_account_id: 'acct-big', duration_minutes: 300 }),
  ]);

  const totals = await getCommunityServiceTotals(ADMIN);
  expect(totals.map((entry) => entry.person_account_id)).toEqual(['acct-big', 'acct-small']);
});

describe('who sees whose hours', () => {
  const gym = () => [
    row({ activity_id: 'a-1', person_account_id: 'acct-kid-mine', athlete_id: 'ath-mine', duration_minutes: 120 }),
    row({ activity_id: 'a-2', person_account_id: 'acct-kid-other', athlete_id: 'ath-other', duration_minutes: 300 }),
    // An adult volunteer: no athlete on the row and no athlete on the login.
    row({ activity_id: 'a-3', person_account_id: 'acct-volunteer', athlete_id: null, duration_minutes: 60 }),
  ];

  test('an organization admin sees every person, volunteers included, and access.ts is not consulted', async () => {
    mockList.mockResolvedValue(gym());

    const totals = await getCommunityServiceTotals(ADMIN);
    expect(totals.map((t) => t.person_account_id).sort()).toEqual(['acct-kid-mine', 'acct-kid-other', 'acct-volunteer']);
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a coach sees only the people whose athlete record access.ts says they reach', async () => {
    mockList.mockResolvedValue(gym());
    mockReach.mockResolvedValue(new Set(['ath-mine']));

    const totals = await getCommunityServiceTotals(COACH);
    expect(totals.map((t) => t.person_account_id)).toEqual(['acct-kid-mine']);
    // The decision was access.ts's, asked once for every athlete the rows name.
    expect(mockReach).toHaveBeenCalledTimes(1);
    const [actor, ids] = mockReach.mock.calls[0];
    expect(actor).toBe(COACH);
    expect([...ids].sort()).toEqual(['ath-mine', 'ath-other']);
  });

  test('a coach who reaches nobody in the rows gets an empty list, never the gym', async () => {
    mockList.mockResolvedValue(gym());
    mockReach.mockResolvedValue(new Set());

    expect(await getCommunityServiceTotals(COACH)).toEqual([]);
  });

  test('a volunteer with no athlete record is hidden from every coach, even one who reaches every athlete', async () => {
    mockList.mockResolvedValue(gym());
    mockReach.mockResolvedValue(new Set(['ath-mine', 'ath-other']));

    const totals = await getCommunityServiceTotals(COACH);
    expect(totals.map((t) => t.person_account_id).sort()).toEqual(['acct-kid-mine', 'acct-kid-other']);
  });

  test('a row with no athlete_id still maps to the athlete through the person login', async () => {
    mockList.mockResolvedValue([
      row({ activity_id: 'a-1', person_account_id: 'acct-kid-login', athlete_id: null, duration_minutes: 45 }),
    ]);
    mockQuery.mockResolvedValue([{ account_id: 'acct-kid-login', athlete_id: 'ath-from-login' }]);
    mockReach.mockResolvedValue(new Set(['ath-from-login']));

    const totals = await getCommunityServiceTotals(COACH);
    expect(totals.map((t) => t.person_account_id)).toEqual(['acct-kid-login']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('pilot.accounts'), ['org-1', ['acct-kid-login']]);
    expect([...mockReach.mock.calls[0][1]]).toEqual(['ath-from-login']);
  });

  test('a person whose rows name an athlete the coach does not reach is hidden even if the login maps to one they do', async () => {
    mockList.mockResolvedValue([
      row({ activity_id: 'a-1', person_account_id: 'acct-p', athlete_id: 'ath-not-mine', duration_minutes: 45 }),
    ]);
    mockQuery.mockResolvedValue([{ account_id: 'acct-p', athlete_id: 'ath-mine' }]);
    mockReach.mockResolvedValue(new Set(['ath-mine']));

    expect(await getCommunityServiceTotals(COACH)).toEqual([]);
  });

  test('a coach read with no rows asks access.ts nothing', async () => {
    mockList.mockResolvedValue([]);
    expect(await getCommunityServiceTotals(COACH)).toEqual([]);
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

test('hours floor, never round up -- the record does not hand out minutes it cannot back', () => {
  expect(wholeHours(59)).toBe(0);
  expect(wholeHours(60)).toBe(1);
  expect(wholeHours(119)).toBe(1);
  expect(wholeHours(0)).toBe(0);
});
