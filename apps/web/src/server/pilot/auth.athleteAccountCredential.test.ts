// The line between "prepare an account for an athlete" and "hand somebody that
// athlete's credentials".
//
// Both constructors below write the same row for the same child, and they are
// NOT interchangeable. createAthleteAccount writes it LIVE on
// DEFAULT_FIRST_LOGIN_PIN -- a constant published in pinPolicy.ts -- which is
// correct only because its one caller (/api/pilot/admin/athlete-accounts) is an
// organization admin standing in the same gym as the athlete, an actor
// assertActorCanAccessAthlete already admits to that child's record.
// createAthleteShellAccount writes it INERT, for a caller the athlete boundary
// does not admit.
//
// The distinction is load-bearing rather than cosmetic: a caller who chooses
// the account_id and knows the starting PIN can sign in as the child, and the
// one route a must_change_pin session may call is /api/pilot/auth/change-pin,
// so the takeover completes in two requests. These tests pin the two shapes so
// a future edit cannot quietly give the inert constructor a credential, or
// strip the roster and binding guards from either.

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
  hashPin: jest.fn(async () => 'hashed-bootstrap-pin'),
  hashToken: jest.fn(),
  verifyPin: jest.fn(),
}));

import { createAthleteAccount, createAthleteShellAccount } from './auth';
import { hashPin } from './security';

const mockHashPin = hashPin as jest.Mock;

/** Whitespace-insensitive SQL match, so indentation is not part of the contract. */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function accountsInsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]: [string]) => squash(sql).startsWith('insert into pilot.accounts'),
  );
}

function membershipInsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]: [string]) => squash(sql).includes('insert into pilot.organization_memberships'),
  );
}

/** The three preconditions both constructors share, in the order they run. */
function allowAssignable() {
  currentClient.query
    .mockResolvedValueOnce({ rows: [{ athlete_id: 'ath-9' }] }) // roster row exists in this org
    .mockResolvedValueOnce({ rows: [] }) // athlete not already linked to an account
    .mockResolvedValueOnce({ rows: [] }); // account_id not already taken
}

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('createAthleteShellAccount', () => {
  test('writes an account that cannot authenticate: no PIN, inactive, inactive membership', async () => {
    allowAssignable();

    await createAthleteShellAccount('shell-acct-1', 'ath-9', 'org-other');

    // No credential is minted at all. loginWithAccountIdAndPin refuses an
    // account with a null pin_hash and refuses an inactive one, so either
    // half alone would be enough -- both are asserted because a later edit
    // that relaxes one must not be able to pass on the other.
    expect(mockHashPin).not.toHaveBeenCalled();

    const inserts = accountsInsertCalls();
    // Non-vacuity: a filter that matched nothing would make every assertion
    // below trivially true.
    expect(inserts).toHaveLength(1);

    const [insertSql, insertParams] = inserts[0];
    expect(squash(insertSql)).toContain(
      "values ($1, 'athlete', $2, $3, null, false, false, false)",
    );
    expect(insertParams).toEqual(['shell-acct-1', 'org-other', 'ath-9']);
    // Nothing resembling a PIN hash rides in on a parameter either.
    expect(insertParams).not.toContain('hashed-bootstrap-pin');

    const memberships = membershipInsertCalls();
    expect(memberships).toHaveLength(1);
    expect(squash(memberships[0][0])).toContain("values ($1, $2, 'athlete', false)");
    expect(memberships[0][1]).toEqual(['shell-acct-1', 'org-other']);
  });

  test('refuses an athlete id the named organization does not have, before any write', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [] }); // no roster row in this org

    await expect(createAthleteShellAccount('shell-acct-1', 'ath-elsewhere', 'org-other')).rejects.toThrow(
      'Athlete not found in organization',
    );

    expect(accountsInsertCalls()).toHaveLength(0);
  });

  test('refuses an athlete who already holds an account, before any write', async () => {
    currentClient.query
      .mockResolvedValueOnce({ rows: [{ athlete_id: 'ath-9' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'the-childs-own-account' }] });

    await expect(createAthleteShellAccount('shell-acct-1', 'ath-9', 'org-other')).rejects.toThrow(
      'Athlete is already linked to another account',
    );

    expect(accountsInsertCalls()).toHaveLength(0);
  });

  test('refuses an account id already in use, before any write', async () => {
    currentClient.query
      .mockResolvedValueOnce({ rows: [{ athlete_id: 'ath-9' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ organization_id: 'org-other' }] });

    await expect(createAthleteShellAccount('taken-acct', 'ath-9', 'org-other')).rejects.toThrow(
      'Account already exists',
    );

    expect(accountsInsertCalls()).toHaveLength(0);
  });
});

describe('createAthleteAccount', () => {
  // Unchanged by the shell fix, and pinned here so it stays that way: the
  // organization admin's own provisioning flow still creates the account live
  // on the bootstrap PIN with must_change_pin set.
  test('still writes the live bootstrap-PIN account for the gym admin flow', async () => {
    allowAssignable();

    await createAthleteAccount('ath-account-1', 'ath-9', 'org-1');

    expect(mockHashPin).toHaveBeenCalledTimes(1);

    const inserts = accountsInsertCalls();
    expect(inserts).toHaveLength(1);

    const [insertSql, insertParams] = inserts[0];
    expect(squash(insertSql)).toContain("values ($1, 'athlete', $2, $3, $4, true, true, false)");
    expect(insertParams).toEqual(['ath-account-1', 'org-1', 'ath-9', 'hashed-bootstrap-pin']);

    const memberships = membershipInsertCalls();
    expect(memberships).toHaveLength(1);
    expect(squash(memberships[0][0])).toContain("values ($1, $2, 'athlete', true)");
  });

  test('keeps the shared roster guard: an athlete outside the organization is refused', async () => {
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(createAthleteAccount('ath-account-1', 'ath-elsewhere', 'org-1')).rejects.toThrow(
      'Athlete not found in organization',
    );

    expect(accountsInsertCalls()).toHaveLength(0);
    expect(mockHashPin).not.toHaveBeenCalled();
  });
});
