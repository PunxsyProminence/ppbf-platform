jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // Deliberately the REAL predicate, not a stub. The point of the loopback
  // cases below is that auth.ts asks the canonical check about the connection
  // string it is actually configured with; a stub would only prove auth.ts
  // calls something.
  isLoopbackPostgresConnectionString: jest.requireActual('./db').isLoopbackPostgresConnectionString,
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(() => 'opaque-token'),
  hashToken: jest.fn(() => 'hashed-token'),
  hashPin: jest.fn(),
  verifyPin: jest.fn(async () => true),
}));

import { loginWithAccountIdAndPin, loginWithMicrosoftEmail, resolvePrincipal } from './auth';
import { query, queryOne } from './db';
import { SESSION_ABSOLUTE_LIFETIME_MS } from './sessionPolicy';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('new sessions store expires_at', () => {
  test('loginWithAccountIdAndPin inserts a 24-hour expires_at for athlete local sessions', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'acct-1',
      role: 'athlete',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: 'ath-1',
      auth_provider: 'ppbf_local',
      pin_hash: 'hash',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });
    mockQuery.mockResolvedValueOnce([]);

    const before = Date.now();
    const result = await loginWithAccountIdAndPin('acct-1', '482913');
    const after = Date.now();

    expect(result).not.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.session_tokens');
    expect(sql).toContain('expires_at');
    const expiresAt = params[3] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_ABSOLUTE_LIFETIME_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_ABSOLUTE_LIFETIME_MS);
  });

  test('a legacy athlete row can never authenticate with the retired shared bootstrap PIN', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'legacy-athlete', role: 'athlete', organization_id: 'org-1', is_platform_owner: false,
      athlete_id: 'ath-legacy', auth_provider: 'ppbf_local', pin_hash: 'hash', must_change_pin: true,
      active_flag: true, has_master_shadow_access: false, organization_status: 'active',
    });

    const result = await loginWithAccountIdAndPin('legacy-athlete', '123456');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('loginWithAccountIdAndPin rejects non-athlete local accounts before writing a session', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'coach-1',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: null,
      auth_provider: 'ppbf_local',
      pin_hash: 'hash',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });

    const result = await loginWithAccountIdAndPin('coach-1', '123456');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('loginWithMicrosoftEmail inserts a 24-hour expires_at', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'coach-ms-1',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: null,
      auth_provider: 'microsoft',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });
    mockQuery.mockResolvedValueOnce([]);

    const before = Date.now();
    const result = await loginWithMicrosoftEmail('coach@example.com');
    const after = Date.now();

    expect(result).not.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.session_tokens');
    expect(sql).toContain('expires_at');
    const expiresAt = params[3] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_ABSOLUTE_LIFETIME_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_ABSOLUTE_LIFETIME_MS);
  });
});

// BASE-03 wiring. The policy matrix lives in credentialPolicy.test.ts; these
// prove the two load-bearing auth paths actually ask it, rather than that the
// helper returns the right answer in isolation.
//
// NODE_ENV is 'test' throughout this suite, so the fence is shut by default --
// which is why the existing non-athlete rejection above still holds. Only the
// cases that explicitly open it set both conditions, and they restore the
// environment afterwards.
const mutableEnv = process.env as Record<string, string | undefined>;

// The isolated offline runtime owns a loopback embedded cluster, so that is the
// default a fence-open case runs under. The remote string is what a developer
// gets by exporting the offline flag while still pointed at a real database --
// the case the third condition exists for.
const LOOPBACK_DATABASE_URL = 'postgres://ppbf:secret@127.0.0.1:5433/ppbf_offline';
const REMOTE_DATABASE_URL = 'postgres://ppbf:secret@ppbf.postgres.database.azure.com:5432/ppbf';

async function withOfflineRuntime<T>(
  run: () => Promise<T>,
  databaseUrl: string = LOOPBACK_DATABASE_URL,
): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.PPBF_OFFLINE_RUNTIME;
  const previousDatabaseUrl = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  // Plain assignment, not Object.defineProperty: process.env is a proxy whose
  // setter is the only thing that actually writes, so defineProperty silently
  // leaves NODE_ENV as 'test' and the fence never opens.
  mutableEnv.NODE_ENV = 'development';
  process.env.PPBF_OFFLINE_RUNTIME = 'true';
  process.env.AZURE_POSTGRES_CONNECTION_STRING = databaseUrl;
  try {
    // Awaited inside the try, not returned from it: returning the promise
    // would restore the environment before auth.ts ever reads it, and every
    // fence-open case would fail for a reason that has nothing to do with the
    // policy under test.
    return await run();
  } finally {
    mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.PPBF_OFFLINE_RUNTIME;
    else process.env.PPBF_OFFLINE_RUNTIME = previousFlag;
    if (previousDatabaseUrl === undefined) delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    else process.env.AZURE_POSTGRES_CONNECTION_STRING = previousDatabaseUrl;
  }
}

function localAccountRow(accountId: string, role: string) {
  return {
    account_id: accountId,
    role,
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'ppbf_local',
    pin_hash: 'hash',
    must_change_pin: false,
    active_flag: true,
    has_master_shadow_access: false,
    organization_status: 'active',
    holds_board_seat: false,
  };
}

/** The same account, holding a seat on this organization's board. */
function seatHoldingAccountRow(accountId: string, role: string) {
  return { ...localAccountRow(accountId, role), holds_board_seat: true };
}

function requestWithSession() {
  return { cookies: { get: () => ({ value: 'opaque-token' }) } } as never;
}

describe('BASE-03 offline local PIN wiring', () => {
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login is refused outside the offline fence, before any session write', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const result = await loginWithAccountIdAndPin(accountId, '482913');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login reaches session creation inside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const result = await withOfflineRuntime(() => loginWithAccountIdAndPin(accountId, '482913'));

    expect(result).not.toBeNull();
    expect(result?.principal.role).toBe(role);
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test('the athlete PIN path is unchanged by the fence', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...localAccountRow('ath-1', 'athlete'), athlete_id: 'a-1' });
    mockQuery.mockResolvedValueOnce([]);

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).not.toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session is revoked on sight outside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await resolvePrincipal(requestWithSession());

    expect(principal).toBeNull();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.session_tokens set revoked_at');
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session survives inside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const principal = await withOfflineRuntime(() => resolvePrincipal(requestWithSession()));

    expect(principal).not.toBeNull();
    expect(principal?.role).toBe(role);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // BASE-04. The server has already decided this session may use a PIN --
  // resolvePrincipal reached its return only because pinLoginPermitted said so.
  // The client cannot re-derive that decision (the fence reads NODE_ENV, the
  // offline flag and the database address, none of which may cross to the
  // browser), so the principal has to carry the ANSWER. Asserted here rather
  // than only at the route, because the route can only report what the
  // principal already knows.
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a surviving ppbf_local %s principal attests that the PIN policy permitted it', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const principal = await withOfflineRuntime(() => resolvePrincipal(requestWithSession()));

    expect(principal?.pinAuthPermitted).toBe(true);
  });

  // The production PIN path: an athlete needs no fence, and the attestation
  // must still be true, because the client now requires it for every local
  // session -- this is the assertion that keeps real athletes signed in.
  test('a surviving athlete ppbf_local principal is attested with no fence at all', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...localAccountRow('ath-1', 'athlete'), athlete_id: 'a-1' });

    const principal = await resolvePrincipal(requestWithSession());

    expect(principal).not.toBeNull();
    expect(principal?.pinAuthPermitted).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a microsoft principal is never attested for PIN', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ...localAccountRow('admin-ms', 'organization_admin'),
      auth_provider: 'microsoft',
      pin_hash: null,
    });

    const principal = await resolvePrincipal(requestWithSession());

    expect(principal).not.toBeNull();
    expect(principal?.pinAuthPermitted).toBe(false);
  });

  test('a ppbf_local parent session is still revoked even inside the offline fence', async () => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow('parent-1', 'parent'));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await withOfflineRuntime(() => resolvePrincipal(requestWithSession()));

    expect(principal).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('update pilot.session_tokens set revoked_at');
  });
});

// P1. The two environment strings above say what a process CALLS itself; they
// do not say what it is connected to. A developer who exports the offline flag
// -- next.config.ts reads it to move distDir off .next, so there is an ordinary
// reason to -- while still pointed at a real database would otherwise open
// admin and coach PIN login against that database, using a PIN published in
// this repository.
//
// These live here rather than in credentialPolicy.test.ts on purpose: the
// policy could be correct in isolation while auth.ts passes it a constant.
// Only an entry-point test can tell those apart.
describe('BASE-03 P1: the offline exception is bound to a loopback database', () => {
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login is refused inside the fence when the database is not loopback', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const result = await withOfflineRuntime(
      () => loginWithAccountIdAndPin(accountId, '482913'),
      REMOTE_DATABASE_URL,
    );

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session is revoked inside the fence when the database is not loopback', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await withOfflineRuntime(
      () => resolvePrincipal(requestWithSession()),
      REMOTE_DATABASE_URL,
    );

    expect(principal).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('update pilot.session_tokens set revoked_at');
  });

  test('an unset connection string is not loopback, so the exception stays shut', async () => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow('coach-1', 'coach'));
    const previous = process.env.AZURE_POSTGRES_CONNECTION_STRING;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.PPBF_OFFLINE_RUNTIME;
    mutableEnv.NODE_ENV = 'development';
    process.env.PPBF_OFFLINE_RUNTIME = 'true';
    delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    try {
      const result = await loginWithAccountIdAndPin('coach-1', '482913');
      expect(result).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      mutableEnv.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env.PPBF_OFFLINE_RUNTIME;
      else process.env.PPBF_OFFLINE_RUNTIME = previousFlag;
      if (previous !== undefined) process.env.AZURE_POSTGRES_CONNECTION_STRING = previous;
    }
  });

  // The positive control for the two cases above: the same roles, the same
  // fence, a loopback connection. Without this a broken harness would look
  // like a passing repair.
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login still reaches session creation on a loopback database', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const result = await withOfflineRuntime(
      () => loginWithAccountIdAndPin(accountId, '482913'),
      LOOPBACK_DATABASE_URL,
    );

    expect(result).not.toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test('the athlete PIN path is unaffected by the database boundary', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...localAccountRow('ath-1', 'athlete'), athlete_id: 'a-1' });
    mockQuery.mockResolvedValueOnce([]);

    const result = await withOfflineRuntime(
      () => loginWithAccountIdAndPin('ath-1', '482913'),
      REMOTE_DATABASE_URL,
    );

    expect(result).not.toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });
});

// P2. The policy has always said a board-seat holder stays on Microsoft: a seat
// is an office with a mailbox, and an offline convenience must not downgrade a
// governance identity. Until now neither auth path loaded seat state, so the
// guard could not fire and the claim was unenforceable.
//
// Every case below runs with the P1 fence fully satisfied -- development, the
// offline flag, and a LOOPBACK database -- so a denial here can only be the
// seat. A case that denied for P1's reason would prove nothing about P2.
describe('BASE-03 P2: a board seat refuses the offline PIN exception', () => {
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s holding a board seat is refused at login, before any session write', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(seatHoldingAccountRow(accountId, role));

    const result = await withOfflineRuntime(
      () => loginWithAccountIdAndPin(accountId, '482913'),
      LOOPBACK_DATABASE_URL,
    );

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session is revoked once the holder has a board seat', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(seatHoldingAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await withOfflineRuntime(
      () => resolvePrincipal(requestWithSession()),
      LOOPBACK_DATABASE_URL,
    );

    expect(principal).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('update pilot.session_tokens set revoked_at');
  });

  // The positive control for both cases above: identical in every respect
  // except the seat. Without it a harness that refused everything would read as
  // a repair.
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s without a board seat is still admitted on the same fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const result = await withOfflineRuntime(
      () => loginWithAccountIdAndPin(accountId, '482913'),
      LOOPBACK_DATABASE_URL,
    );

    expect(result).not.toBeNull();
    expect(result?.principal.role).toBe(role);
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test('both auth queries ask pilot.board_seats for the fact themselves', async () => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow('coach-1', 'coach'));
    mockQuery.mockResolvedValueOnce([]);

    await withOfflineRuntime(() => loginWithAccountIdAndPin('coach-1', '482913'), LOOPBACK_DATABASE_URL);

    // The row is mocked, so nothing else proves the production query actually
    // carries the seat lookup rather than reading a field only the test sets.
    const [loginSql] = mockQueryOne.mock.calls[0];
    expect(loginSql).toContain('pilot.board_seats');
    expect(loginSql).toContain('holds_board_seat');

    jest.clearAllMocks();
    mockQueryOne.mockResolvedValueOnce(localAccountRow('coach-1', 'coach'));
    await withOfflineRuntime(() => resolvePrincipal(requestWithSession()), LOOPBACK_DATABASE_URL);

    const [sessionSql] = mockQueryOne.mock.calls[0];
    expect(sessionSql).toContain('pilot.board_seats');
    expect(sessionSql).toContain('holds_board_seat');
  });
});
