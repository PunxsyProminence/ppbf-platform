// Audit CL-A7. requireMicrosoftAuthenticatedPrincipal promises a Microsoft
// SESSION, so it reads how the session was signed in, not the account's
// provider. requireStaffSessionPrincipal is the honest gate for the routes
// coaches use (they sign in by emailed link or password): any non-PIN session.
import type { NextRequest } from 'next/server';

import type { PilotPrincipal } from './auth';
import { resolvePrincipal } from './auth';
import { requireMicrosoftAuthenticatedPrincipal, requireStaffSessionPrincipal } from './http';

jest.mock('./auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolve = resolvePrincipal as jest.Mock;
const request = {} as NextRequest;

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('requireMicrosoftAuthenticatedPrincipal', () => {
  test('admits a session signed in with Microsoft', async () => {
    mockResolve.mockResolvedValueOnce(principal({ role: 'organization_admin', signInMethod: 'microsoft' }));
    await expect(requireMicrosoftAuthenticatedPrincipal(request)).resolves.toMatchObject({ accountId: 'acct-1' });
  });

  test.each(['magic_link', 'password', 'pin'] as const)(
    "refuses a %s session on an account whose provider is 'microsoft'",
    async (signInMethod) => {
      mockResolve.mockResolvedValueOnce(principal({ signInMethod }));
      await expect(requireMicrosoftAuthenticatedPrincipal(request))
        .rejects.toThrow('Forbidden: Microsoft-authenticated session required');
    },
  );

  test('refuses a session with no recorded sign-in method', async () => {
    // Sessions minted before the Microsoft insert recorded it. At most 24
    // hours old; signing in again records it.
    mockResolve.mockResolvedValueOnce(principal({ signInMethod: null }));
    await expect(requireMicrosoftAuthenticatedPrincipal(request)).rejects.toThrow(/^Forbidden/);
  });

  test('refuses a Microsoft-recorded session on a local account', async () => {
    mockResolve.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local', signInMethod: 'microsoft' }));
    await expect(requireMicrosoftAuthenticatedPrincipal(request)).rejects.toThrow(/^Forbidden/);
  });
});

describe('requireStaffSessionPrincipal', () => {
  test.each(['microsoft', 'magic_link', 'password'] as const)('admits a %s session', async (signInMethod) => {
    mockResolve.mockResolvedValueOnce(principal({ signInMethod }));
    await expect(requireStaffSessionPrincipal(request)).resolves.toMatchObject({ accountId: 'acct-1' });
  });

  test('refuses a PIN session', async () => {
    mockResolve.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local', role: 'athlete', signInMethod: 'pin' }));
    await expect(requireStaffSessionPrincipal(request)).rejects.toThrow(/^Forbidden/);
  });

  test('refuses a local-provider account whatever its session says', async () => {
    mockResolve.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local', signInMethod: 'password' }));
    await expect(requireStaffSessionPrincipal(request)).rejects.toThrow(/^Forbidden/);
  });

  test('refuses a session with no recorded sign-in method', async () => {
    mockResolve.mockResolvedValueOnce(principal({ signInMethod: null }));
    await expect(requireStaffSessionPrincipal(request)).rejects.toThrow(/^Forbidden/);
  });

  test('still applies the bootstrap-PIN stop', async () => {
    mockResolve.mockResolvedValueOnce(principal({ signInMethod: 'magic_link', mustChangePin: true }));
    await expect(requireStaffSessionPrincipal(request)).rejects.toThrow(/PIN change required/);
  });
});
