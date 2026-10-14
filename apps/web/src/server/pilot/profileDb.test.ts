// SQL-shape pins for the two profileDb pieces the portrait-review console's
// safety gate stands on (same idiom as trainingHolds.test.ts's probe pins).
// Nothing else executes this module's SQL in a unit or pg suite, and both
// pieces fail SILENTLY if they rot: a lost ::text cast turns the photo
// identity into a millisecond-rounded Date that can never compare equal
// (approve refuses everyone), and a lost CAS guard releases a photograph the
// reviewer never saw (approve refuses no one).

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
}));

import { query, queryOne } from './db';
import { getAccountProfile, getSubjectIdentity, releasePhoto, resolveRelationship } from './profileDb';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

test('profile reads select photo_uploaded_at::text -- the exact-identity form equality depends on', async () => {
  await getAccountProfile('org-1', 'acct-1');

  const [sql] = mockQueryOne.mock.calls[0];
  expect(String(sql)).toContain('photo_uploaded_at::text');
});

// The behaviour itself (a deleted athlete, and a deleted login, come back as
// nobody) runs against real Postgres in athleteSelfPathsDeletion.pg.test.ts;
// this pins the read's shape so a mocked-db refactor cannot drop the mark.
test('getSubjectIdentity reads the account through accountNotDeletedSql, so a deleted person is nobody', async () => {
  await expect(getSubjectIdentity('org-1', 'acct-1')).resolves.toBeNull();

  const [sql, params] = mockQueryOne.mock.calls[0];
  expect(String(sql)).toContain('deleted_account.deleted_at is not null');
  expect(String(sql)).toContain('deleted_athlete.deleted_at is not null');
  expect(params).toEqual(['org-1', 'acct-1']);
});

test("resolveRelationship's athlete-viewer arm reads the live row only, so a deleted athlete's session is nobody's athlete", async () => {
  const viewer = { accountId: 'acct-ath', role: 'athlete' as const, organizationId: 'org-1', athleteId: 'ath-gone' };
  const staff = { accountId: 'acct-coach', fullName: 'Coach', athleteId: null, dob: null, coachAccountId: null, memberSince: '' };
  await expect(resolveRelationship(viewer, staff, 'org-1')).resolves.toBe('none');

  const [sql, params] = mockQueryOne.mock.calls[0];
  expect(String(sql)).toMatch(/from pilot\.athletes[\s\S]*coach_id = \$3[\s\S]*deleted_at is null/);
  expect(params).toEqual(['org-1', 'ath-gone', 'acct-coach']);
});

describe('releasePhoto compare-and-swap composition', () => {
  test('ungated call (the sibling review route): no state or identity predicate', async () => {
    await releasePhoto('org-1', 'acct-1', 'acct-reviewer');

    const [sql, params] = mockQuery.mock.calls[0];
    // The SET clause always writes photo_review_state = 'released'; what must
    // be absent ungated is any PARAMETERIZED guard in the WHERE clause.
    expect(String(sql)).not.toMatch(/photo_review_state = \$/);
    expect(String(sql)).not.toMatch(/photo_uploaded_at = \$/);
    expect(params).toEqual(['org-1', 'acct-1', 'acct-reviewer']);
  });

  test('state guard alone binds $4', async () => {
    await releasePhoto('org-1', 'acct-1', 'acct-reviewer', 'pending_review');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('photo_review_state = $4');
    expect(String(sql)).not.toMatch(/photo_uploaded_at = \$/);
    expect(params).toEqual(['org-1', 'acct-1', 'acct-reviewer', 'pending_review']);
  });

  test('state AND attested identity: both predicates are on the UPDATE itself, and zero rows reports false', async () => {
    const attested = '2026-08-10 09:00:00.123456+00';

    // Zero rows -- a replacement (or another reviewer) got there first.
    await expect(
      releasePhoto('org-1', 'acct-1', 'acct-reviewer', 'pending_review', attested),
    ).resolves.toBe(false);

    const [sql, params] = mockQuery.mock.calls[0];
    // The identity is a WHERE predicate of the single UPDATE -- the row lock
    // re-evaluates it at write time, which is the whole TOCTOU close. A
    // separate pre-check would reopen the window.
    expect(String(sql)).toContain('photo_review_state = $4');
    expect(String(sql)).toContain('photo_uploaded_at = $5');
    expect(params).toEqual(['org-1', 'acct-1', 'acct-reviewer', 'pending_review', attested]);

    // A matched row reports true.
    mockQuery.mockResolvedValueOnce([{ account_id: 'acct-1' }]);
    await expect(
      releasePhoto('org-1', 'acct-1', 'acct-reviewer', 'pending_review', attested),
    ).resolves.toBe(true);
  });
});

/* Dates of birth pinned to the GYM's calendar day, the way the rule reads
   them (wallDisplay.isMinor via guardianAccess.guardianLinkEnded): one athlete
   turned 18 today at the gym, the other turns 18 tomorrow and is a minor
   until local midnight. */
const gymYmd = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
/* Calendar arithmetic on the gym-date STRING, not on Date.now() + 24h: in the
   hour the clocks fall back, now + 24h is still the same New York day. */
const nextDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
/* 18 years earlier. A Feb 29 has no birthday 18 years back: the adult fixture
   takes Feb 28 (18 by today either way), the minor fixture Mar 1 (still 17). */
const minus18 = (ymd: string, leapDay: '02-28' | '03-01') => {
  const year = Number(ymd.slice(0, 4)) - 18;
  const monthDay = ymd.slice(5);
  return `${year}-${monthDay === '02-29' ? leapDay : monthDay}`;
};
const GYM_TODAY = gymYmd(new Date());
const ADULT_DOB = minus18(GYM_TODAY, '02-28');
const MINOR_DOB = minus18(nextDay(GYM_TODAY), '03-01');

describe("resolveRelationship's parent arm goes dormant at 18 (OD-2026-10-07-008)", () => {
  const viewer = { accountId: 'acct-parent', role: 'parent' as const, organizationId: 'org-1', athleteId: null };
  const subject = (dob: string | null) =>
    ({ accountId: 'acct-ath', fullName: 'Kid', athleteId: 'ath-1', dob, coachAccountId: 'acct-coach', memberSince: '' });

  test('an adult subject is another family to their former guardian, before the link is even read', async () => {
    await expect(resolveRelationship(viewer, subject(ADULT_DOB), 'org-1')).resolves.toBe('none');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('a subject who turns 18 tomorrow still resolves through the link today', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(resolveRelationship(viewer, subject(MINOR_DOB), 'org-1')).resolves.toBe('guardian_of_subject');
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(resolveRelationship(viewer, subject(null), 'org-1')).resolves.toBe('guardian_of_subject');
  });
});
