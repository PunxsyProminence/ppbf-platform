import { NextRequest } from 'next/server';

import { POST } from './route';
import { DEFAULT_FIRST_LOGIN_PIN } from '@/src/server/pilot/pinPolicy';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

/**
 * This route had no test at all, which is how it stayed broken while the
 * suite stayed green: it is the one remaining caller of createAthleteAccount,
 * so a change to that function is invisible here unless something exercises
 * the seam. Nothing did.
 *
 * Two things are asserted together on purpose. That the route still WORKS --
 * a platform owner preparing an athlete shell in a gym must not get a 500 --
 * and that what it writes is INERT: no PIN, account inactive, membership
 * inactive. Either one alone can be satisfied by a change that breaks the
 * other.
 */
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn(async () => undefined) }));

const client = {
  query: jest.fn(async (sql: string, _params?: unknown[]) => {
    // The roster row exists; nothing is bound to it; the account id is free.
    if (/from pilot\.athletes/.test(sql)) return { rows: [{ athlete_id: 'ath-1' }] };
    return { rows: [] };
  }),
};

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client)),
  sanitizedSqlState: jest.fn(() => undefined),
}));

const mockPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;

function shellRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/platform/athlete-shell', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function platformOwner() {
  mockPrincipal.mockResolvedValueOnce({
    accountId: 'owner@punxsyprominence.org',
    role: 'platform_owner',
    organizationId: 'org-platform',
    athleteId: null,
    authProvider: 'microsoft',
  });
}

beforeEach(() => {
  client.query.mockClear();
  mockPrincipal.mockReset();
});

function accountInsert() {
  return client.query.mock.calls.find(([sql]) => /insert into pilot\.accounts/.test(String(sql)));
}

describe('POST /api/pilot/platform/athlete-shell', () => {
  test('a platform owner can still prepare an athlete shell', async () => {
    platformOwner();

    const response = await POST(shellRequest({ organization_id: 'org-1', account_id: 'ath-login', athlete_id: 'ath-1' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      account_id: 'ath-login',
      athlete_id: 'ath-1',
      organization_id: 'org-1',
    });
  });

  test('the shell it writes has no PIN and cannot sign in', async () => {
    platformOwner();

    await POST(shellRequest({ organization_id: 'org-1', account_id: 'ath-login', athlete_id: 'ath-1' }));

    const insert = accountInsert();
    expect(insert).toBeDefined();
    // pin_hash null, must_change_pin false, active_flag false, not owner.
    expect(insert?.[0]).toContain('null, false, false, false');
    // The retired shared credential is never written, hashed or otherwise:
    // the params carry only identifiers, and there is no fourth one to hold
    // a PIN hash.
    expect(insert?.[1]).not.toContain(DEFAULT_FIRST_LOGIN_PIN);
    expect(insert?.[1]).toEqual(['ath-login', 'org-1', 'ath-1']);

    const membership = client.query.mock.calls.find(([s]) => /insert into pilot\.organization_memberships/.test(String(s)));
    expect(membership?.[0]).toContain('active_flag = false');
  });

  test('the route does not issue an activation code', async () => {
    platformOwner();

    await POST(shellRequest({ organization_id: 'org-1', account_id: 'ath-login', athlete_id: 'ath-1' }));

    // Minting a code is the gym admin's act, deliberately not the platform
    // owner's -- see the route's own header comment.
    expect(client.query.mock.calls.some(([sql]) => /account_activation_tokens/.test(String(sql)))).toBe(false);
  });

  test('an athlete id that is not on that gym roster is refused before any write', async () => {
    platformOwner();
    client.query.mockImplementationOnce(async () => ({ rows: [] }));

    const response = await POST(shellRequest({ organization_id: 'org-1', account_id: 'ath-login', athlete_id: 'not-a-roster-row' }));

    expect(response.status).not.toBe(200);
    expect(accountInsert()).toBeUndefined();
  });

  test('a non-platform-owner is refused', async () => {
    mockPrincipal.mockResolvedValueOnce({
      accountId: 'admin@punxsyprominence.org',
      role: 'organization_admin',
      organizationId: 'org-1',
      athleteId: null,
      authProvider: 'microsoft',
    });

    const response = await POST(shellRequest({ organization_id: 'org-1', account_id: 'ath-login', athlete_id: 'ath-1' }));

    expect(response.status).toBe(403);
    expect(accountInsert()).toBeUndefined();
  });
});
