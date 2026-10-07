import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { resolvePrincipal } from '@/src/server/pilot/auth';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// resolvePrincipal is the mock boundary, not the gate: the route's real
// requirePrincipalForSignOut runs here, so "a session that still owes a PIN
// change gets through" is a statement about the gate, not about a stub.
jest.mock('@/src/server/pilot/auth', () => {
  const actual = jest.requireActual('@/src/server/pilot/auth');
  return { ...actual, resolvePrincipal: jest.fn() };
});

// The db layer is the mock boundary, NOT the auth module. These tests run the
// real revokeAllSessionsForAccountInOrganization, so what they pin is the
// route's actual revocation -- its organization scoping, its membership
// requirement and its platform-owner refusal -- rather than a stub standing in
// for it. Mocking the revoke function itself would have made every assertion
// below a statement about the test's own double.
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-guardian-1',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'magic_link',
    ...overrides,
  };
}

/** An active membership for this (account, organization), which is what
    revokeAllSessionsForAccountInOrganization authorizes against. */
function membership(overrides: { account_id?: string; is_platform_owner?: boolean } = {}) {
  return { account_id: 'acct-guardian-1', is_platform_owner: false, ...overrides };
}

function makeRequest(body: unknown = {}) {
  return new NextRequest('http://localhost/api/pilot/auth/logout-all', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** The one UPDATE that revokes. Isolated by SQL rather than call index so a
    future added query cannot silently shift what these assertions read. */
function revocationCall() {
  return mockQuery.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes('update pilot.session_tokens'),
  );
}

describe('POST /api/pilot/auth/logout-all', () => {
  test('401 when unauthenticated', async () => {
    // resolvePrincipal answers null for no cookie, an unknown token, a revoked
    // or expired one, and a deleted account alike.
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(revocationCall()).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an athlete still owing a PIN change can end every session they hold here', async () => {
    // The defect this route shared with /logout: requirePrincipal refused a
    // mustChangePin session, so the one account that most needs to end its
    // sessions -- a child still on a PIN somebody at the gym knows -- could
    // not. The real requirePrincipalForSignOut runs here.
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'acct-athlete-1', role: 'athlete', athleteId: 'ATH-1', authProvider: 'ppbf_local', mustChangePin: true }),
    );
    mockQueryOne.mockResolvedValueOnce(membership({ account_id: 'acct-athlete-1' }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(revocationCall()?.[1]).toEqual(['acct-athlete-1', 'org-1']);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('that same session is still refused by requirePrincipal', async () => {
    // The stop is skipped for signing out and nowhere else.
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'acct-athlete-1', role: 'athlete', authProvider: 'ppbf_local', mustChangePin: true }),
    );

    await expect(requirePrincipal(makeRequest())).rejects.toThrow('Forbidden: PIN change required');
  });

  test('a guardian on a magic link revokes their own sessions in their own organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(membership());

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    // The account and organization come from the principal, not the request.
    expect(revocationCall()?.[1]).toEqual(['acct-guardian-1', 'org-1']);
  });

  test('an account_id in the body cannot redirect the revocation', async () => {
    // The route takes no parameters at all, and this is the test that keeps it
    // that way. A body naming somebody else must revoke the CALLER's sessions,
    // not the named account's -- a route that can be pointed at an account id
    // is a route that will eventually be pointed at the wrong one.
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(membership());

    const response = await POST(
      makeRequest({ account_id: 'acct-someone-else', organization_id: 'org-2' }),
    );

    expect(response.status).toBe(200);
    expect(revocationCall()?.[1]).toEqual(['acct-guardian-1', 'org-1']);
  });

  test('the revoked caller stops carrying the token they arrived with', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(membership());

    const response = await POST(makeRequest());

    const cookie = response.cookies.get('ppbf_pilot_session');
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  test('an account with no active membership here revokes nothing', async () => {
    // The membership row is the authorization. Without one the shared function
    // refuses, and the route must surface that rather than proceeding to write
    // an audit row for a revocation that did not happen.
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).not.toBe(200);
    expect(revocationCall()).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a platform owner can sign out their own sessions', async () => {
    // Audit CL-A17: the shared admin-revoke function refuses a platform owner
    // target, and this route used to inherit that, leaving the most
    // privileged account no self-service way to end its sessions after a
    // suspected compromise. Acting on yourself is not acting on the owner.
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'acct-owner', role: 'platform_owner', authProvider: 'microsoft' }),
    );
    mockQueryOne.mockResolvedValueOnce(membership({ account_id: 'acct-owner', is_platform_owner: true }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(revocationCall()?.[1]).toEqual(['acct-owner', 'org-1']);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('the audit row names the caller as both actor and subject', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(membership());

    await POST(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: 'acct-guardian-1',
        actor_role: 'parent',
        organization_id: 'org-1',
        entity_id: 'acct-guardian-1',
        details: { action: 'session_revoke_all_self' },
      }),
    );
  });

  test('an athlete on a PIN can sign out their own sessions too', async () => {
    // The capability is not parent-specific. An athlete's PIN is a weaker
    // credential than a guardian's inbox, not a stronger one, so gating this
    // on a Microsoft session would withhold it from the accounts that need it
    // most.
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'acct-athlete-1', role: 'athlete', athleteId: 'ATH-1', authProvider: 'ppbf_local' }),
    );
    mockQueryOne.mockResolvedValueOnce(membership({ account_id: 'acct-athlete-1' }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(revocationCall()?.[1]).toEqual(['acct-athlete-1', 'org-1']);
  });
});
