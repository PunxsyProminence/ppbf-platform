function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(),
  hashPin: jest.fn(async () => 'hashed-pin'),
  hashToken: jest.fn(),
  verifyPin: jest.fn(),
}));

import { createAthleteAccount, createOrUpdateAthleteAccount } from './auth';
import { query } from './db';

const mockQuery = query as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('createOrUpdateAthleteAccount', () => {
  test('inserts a new pending athlete account and assigns inactive membership when none exists yet', async () => {
    mockQuery.mockResolvedValueOnce([]); // no existing account

    await createOrUpdateAthleteAccount('acct_1', 'athlete_1', 'org_1');

    expect(currentClient.query).toHaveBeenCalledTimes(2);

    const [insertSql, insertParams] = currentClient.query.mock.calls[0];
    expect(insertSql).toContain('insert into pilot.accounts');
    expect(insertParams).toEqual(['acct_1', 'athlete', 'org_1', 'athlete_1', null, false, false]);

    const [membershipSql, membershipParams] = currentClient.query.mock.calls[1];
    expect(membershipSql).toContain('pilot.organization_memberships');
    expect(membershipParams).toEqual(['acct_1', 'org_1']);
  });

  test('updates the existing account to pending state, reassigns inactive membership, and revokes sessions on rerun', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org_1' }]); // existing account

    await createOrUpdateAthleteAccount('acct_1', 'athlete_1', 'org_1');

    expect(currentClient.query).toHaveBeenCalledTimes(3);

    const [updateSql, updateParams] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('update pilot.accounts');
    expect(updateParams).toEqual(['athlete', 'athlete_1', null, false, 'acct_1', 'org_1']);

    const [membershipSql] = currentClient.query.mock.calls[1];
    expect(membershipSql).toContain('pilot.organization_memberships');

    const [revokeSql, revokeParams] = currentClient.query.mock.calls[2];
    expect(revokeSql).toContain('pilot.session_tokens');
    expect(revokeParams).toEqual(['acct_1']);
  });

  test('rejects reassigning an account that belongs to another organization', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org_other' }]);

    await expect(createOrUpdateAthleteAccount('acct_1', 'athlete_1', 'org_1')).rejects.toThrow(
      'Account already exists in another organization',
    );

    expect(currentClient.query).not.toHaveBeenCalled();
  });
});

// The binding guard on the shell constructor. createAthleteAccount is reached
// by /api/pilot/platform/athlete-shell, whose caller is a platform owner --
// the one role assertActorCanAccessAthlete refuses an athlete record to. That
// caller supplies both the account_id and the athlete_id, so without this
// guard it could bind a SECOND account to a child who already has one: the
// child keeps signing into theirs while the new row, in an organization the
// caller names, answers to a credential the caller controls.
//
// The route suite pins the shape of the row that gets written. What is pinned
// here is that for an already-bound athlete no row is written at all, and that
// the refusal lands before the insert rather than relying on a unique index.
describe('createAthleteAccount binding guards', () => {
  /** The roster lookup succeeds; later responses are per-test. */
  function athleteIsOnRoster() {
    currentClient.query.mockResolvedValueOnce({ rows: [{ athlete_id: 'athlete_1' }] });
  }

  function writeCalls() {
    return currentClient.query.mock.calls.filter(([sql]: [string]) =>
      /insert into pilot\.(accounts|organization_memberships)/.test(String(sql)),
    );
  }

  test('refuses to bind a second account to an athlete who already holds one', async () => {
    athleteIsOnRoster();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'the_childs_own_account' }] });

    await expect(createAthleteAccount('acct_new', 'athlete_1', 'org_1')).rejects.toThrow(
      'Athlete is already linked to another account',
    );

    expect(writeCalls()).toHaveLength(0);
  });

  test('allows the rerun that re-binds the athlete to the same account id', async () => {
    athleteIsOnRoster();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'acct_same' }] }); // same id, not a second account
    currentClient.query.mockResolvedValueOnce({ rows: [] }); // account row itself not present yet

    await expect(createAthleteAccount('acct_same', 'athlete_1', 'org_1')).resolves.toBeUndefined();

    // Non-vacuity: the previous test's expectation of zero writes only means
    // something if this path does write.
    expect(writeCalls()).toHaveLength(2);
  });

  test('refuses an athlete the named organization does not have, before any write', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [] }); // no roster row in this org

    await expect(createAthleteAccount('acct_new', 'athlete_elsewhere', 'org_1')).rejects.toThrow(
      'Athlete not found in organization',
    );

    expect(writeCalls()).toHaveLength(0);
  });
});
