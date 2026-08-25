// THE PLATFORM-OWNER SHELL MUST STAY A SHELL.
//
// This route is platform_owner-only and takes organization_id from the body,
// which is correct -- Omega prepares accounts in gyms that are not its own.
// What must never travel with that reach is a working athlete credential.
// assertActorCanAccessAthlete refuses platform_owner an athlete record
// unconditionally and first (access.ts), and every athlete-credential route in
// this codebase says the same thing in its own words: activation-codes,
// athlete-pin-directory, accounts/pin-reset, accounts/revoke and
// platform/users/create all exclude the role by name.
//
// The regression this guards is not a missing role check -- the role check is
// right. It is the constructor underneath: createAthleteAccount creates the
// account LIVE on DEFAULT_FIRST_LOGIN_PIN (a published constant), and this
// caller chooses the account_id. That combination is a credential for a named
// minor in any gym the body names, redeemable in two requests -- sign in on the
// starting PIN, then change it on /api/pilot/auth/change-pin, the one route a
// must_change_pin session may call.
//
// So these tests deliberately do NOT mock the auth module. They assert the row
// that actually reaches the database, because "which function the route calls"
// is not the property that matters.

import { NextRequest } from 'next/server';

function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('@/src/server/pilot/security', () => ({
  createOpaqueToken: jest.fn(),
  hashPin: jest.fn(async () => 'hashed-bootstrap-pin'),
  hashToken: jest.fn(),
  verifyPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  // Mirrors the real jsonError's prefix mapping for the statuses these cases
  // produce, so a status assertion here means what it means in production.
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    if (message.startsWith('Missing')) return new Response(JSON.stringify({ error: message }), { status: 400 });
    if (message.startsWith('Athlete not found')) return new Response(JSON.stringify({ error: message }), { status: 404 });
    if (message.startsWith('Athlete is already linked') || message.startsWith('Account already exists')) {
      return new Response(JSON.stringify({ error: message }), { status: 409 });
    }
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

import { POST } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { hashPin } from '@/src/server/pilot/security';

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockHashPin = hashPin as jest.Mock;

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function accountsInsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]: [string]) => squash(sql).startsWith('insert into pilot.accounts'),
  );
}

function principal(role: string) {
  return {
    accountId: 'owner@punxsyprominence.org',
    role,
    organizationId: 'org-omega',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/platform/athlete-shell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The three preconditions the constructor checks before it writes anything. */
function allowAssignable() {
  currentClient.query
    .mockResolvedValueOnce({ rows: [{ athlete_id: 'ath-9' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/platform/athlete-shell', () => {
  test('prepares an inert shell in another gym: no PIN, inactive, no way to sign in', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
    allowAssignable();

    const response = await POST(
      request({ organization_id: 'org-other', account_id: 'shell-acct-1', athlete_id: 'ath-9' }),
    );

    expect(response.status).toBe(200);

    // The whole finding in one assertion: no credential is minted for a child
    // in a gym this role may not reach.
    expect(mockHashPin).not.toHaveBeenCalled();

    const inserts = accountsInsertCalls();
    // Non-vacuity: without this, a filter that matched no call would make the
    // assertions below pass by never running.
    expect(inserts).toHaveLength(1);

    const [insertSql, insertParams] = inserts[0];
    expect(squash(insertSql)).toContain("values ($1, 'athlete', $2, $3, null, false, false, false)");
    expect(insertParams).toEqual(['shell-acct-1', 'org-other', 'ath-9']);
    expect(insertParams).not.toContain('hashed-bootstrap-pin');

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      account_id: 'shell-acct-1',
      athlete_id: 'ath-9',
      organization_id: 'org-other',
      account_state: 'pending_pin_activation',
    });
  });

  test('still refuses an athlete id the named organization does not have', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    const response = await POST(
      request({ organization_id: 'org-other', account_id: 'shell-acct-1', athlete_id: 'ath-elsewhere' }),
    );

    expect(response.status).toBe(404);
    expect(accountsInsertCalls()).toHaveLength(0);
  });

  test('still refuses an athlete who already holds an account', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
    currentClient.query
      .mockResolvedValueOnce({ rows: [{ athlete_id: 'ath-9' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'the-childs-own-account' }] });

    const response = await POST(
      request({ organization_id: 'org-other', account_id: 'shell-acct-1', athlete_id: 'ath-9' }),
    );

    expect(response.status).toBe(409);
    expect(accountsInsertCalls()).toHaveLength(0);
  });

  // The role gate itself, restated here so the two halves of the boundary sit
  // in one file: only platform_owner reaches this route at all, and it reaches
  // it without a credential.
  test('refuses an organization admin, who provisions through their own gym route', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(
      request({ organization_id: 'org-other', account_id: 'shell-acct-1', athlete_id: 'ath-9' }),
    );

    expect(response.status).toBe(403);
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test('refuses a PIN session outright', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await POST(
      request({ organization_id: 'org-other', account_id: 'shell-acct-1', athlete_id: 'ath-9' }),
    );

    expect(response.status).toBe(403);
    expect(currentClient.query).not.toHaveBeenCalled();
  });
});
