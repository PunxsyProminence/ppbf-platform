import { NextRequest } from 'next/server';

import { POST } from './route';
import { logoutWithToken, resolvePrincipal } from '@/src/server/pilot/auth';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import {
  requireMicrosoftAuthenticatedPrincipal,
  requireMicrosoftOrAttestedLocalPinPrincipal,
  requirePrincipal,
  requireStaffSessionPrincipal,
} from '@/src/server/pilot/http';

// The auth module is the mock boundary, NOT http. These tests run the real
// requirePrincipalForSignOut, so what they pin is the route's actual gate --
// that a session still owing a PIN change gets through it, and that nobody
// unauthenticated does -- rather than a stub standing in for the gate.
jest.mock('@/src/server/pilot/auth', () => {
  const actual = jest.requireActual('@/src/server/pilot/auth');
  return { ...actual, resolvePrincipal: jest.fn(), logoutWithToken: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.Mock;
const mockLogoutWithToken = logoutWithToken as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/** An athlete still holding the starting PIN the gym gave them. */
function bootstrapPinPrincipal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ATH-1',
    sessionToken: 'tablet-token',
    authProvider: 'ppbf_local',
    signInMethod: 'pin',
    pinAuthPermitted: true,
    mustChangePin: true,
    ...overrides,
  };
}

function makeRequest(token: string | null = 'tablet-token') {
  return new NextRequest('http://localhost/api/pilot/auth/logout', {
    method: 'POST',
    headers: token === null ? {} : { cookie: `${PILOT_SESSION_COOKIE}=${token}` },
  });
}

describe('POST /api/pilot/auth/logout', () => {
  test('a session that still owes a PIN change can sign out', async () => {
    // The defect: requirePrincipal refused this session, so an athlete sent
    // to /change-pin could not sign out of a shared gym tablet.
    mockResolvePrincipal.mockResolvedValueOnce(bootstrapPinPrincipal());

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // The token revoked is the one in the caller's own cookie.
    expect(mockLogoutWithToken).toHaveBeenCalledWith('tablet-token');
  });

  test('the same session is still refused by every data-serving gate', async () => {
    // This is what keeps the fix narrow: the bootstrap-PIN stop is skipped
    // for signing out and nowhere else. Every gate a data route can use is
    // built on requirePrincipal and still refuses this session.
    const gates = [
      requirePrincipal,
      requireStaffSessionPrincipal,
      requireMicrosoftAuthenticatedPrincipal,
      requireMicrosoftOrAttestedLocalPinPrincipal,
    ];
    for (const gate of gates) {
      mockResolvePrincipal.mockResolvedValueOnce(bootstrapPinPrincipal());
      await expect(gate(makeRequest())).rejects.toThrow('Forbidden: PIN change required');
    }
  });

  test('the sign-out is audited under the caller and the cookie is cleared', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(bootstrapPinPrincipal());

    const response = await POST(makeRequest());

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'logout',
        actor_account_id: 'acct-athlete-1',
        actor_role: 'athlete',
        organization_id: 'org-1',
        entity_type: 'account',
        entity_id: 'acct-athlete-1',
      }),
    );
    const cookie = response.cookies.get(PILOT_SESSION_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  test('a session that has already chosen its PIN still signs out', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(bootstrapPinPrincipal({ mustChangePin: false }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockLogoutWithToken).toHaveBeenCalledWith('tablet-token');
  });

  test('401 when the cookie resolves to nobody (revoked, expired, deleted or unknown token)', async () => {
    // resolvePrincipal returns null for every one of those; the route must
    // not touch a token it could not attribute, and must not audit a sign-out
    // that did not happen.
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(makeRequest('dead-token'));

    expect(response.status).toBe(401);
    expect(mockLogoutWithToken).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('401 with no cookie at all', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(makeRequest(null));

    expect(response.status).toBe(401);
    expect(mockLogoutWithToken).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
