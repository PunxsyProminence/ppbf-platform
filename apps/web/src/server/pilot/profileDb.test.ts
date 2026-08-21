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
import { getAccountProfile, releasePhoto } from './profileDb';

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
