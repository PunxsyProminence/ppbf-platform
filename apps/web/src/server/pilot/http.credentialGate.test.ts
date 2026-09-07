import { NextRequest } from 'next/server';

import { resolvePrincipal } from './auth';
import {
  requireMicrosoftAuthenticatedPrincipal,
  requireMicrosoftOrAttestedLocalPinPrincipal,
} from './http';

// The credential gate under test sits on requirePrincipal, which sits on
// resolvePrincipal. Only the bottom of that stack is replaced, so the
// bootstrap-PIN stop and the Unauthorized refusal are the real ones.
jest.mock('./auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolvePrincipal = jest.mocked(resolvePrincipal);

// pinAuthPermitted is deliberately absent by default: resolvePrincipal always
// sets it, but a principal built anywhere else does not carry it, and the
// gate must read absence as "not attested".
function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    mustChangePin: false,
    ...overrides,
  } as never;
}

function request() {
  return new NextRequest('https://ppbf.example/api/pilot/admin/staff', { method: 'GET' });
}

// resetAllMocks, not clearAllMocks: a queued mockResolvedValueOnce that a
// refused call never consumed must not leak into the next test.
afterEach(() => {
  jest.resetAllMocks();
});

describe('requireMicrosoftOrAttestedLocalPinPrincipal', () => {
  test.each([
    ['microsoft', undefined],
    ['microsoft', false],
    ['ppbf_local', true],
  ])('admits %s with pinAuthPermitted=%s and returns the resolved principal unchanged', async (authProvider, pinAuthPermitted) => {
    const resolved = principal(
      pinAuthPermitted === undefined ? { authProvider } : { authProvider, pinAuthPermitted },
    );
    mockResolvePrincipal.mockResolvedValueOnce(resolved);

    await expect(requireMicrosoftOrAttestedLocalPinPrincipal(request())).resolves.toBe(resolved);
  });

  // Strict `=== true`: absence, false and a truthy string all refuse. The
  // server writes a real boolean; anything else is not the server's word.
  test.each([
    ['ppbf_local', false],
    ['ppbf_local', undefined],
    ['ppbf_local', 'true'],
    ['magic_link', undefined],
    ['magic_link', true],
    ['saml', true],
  ])('refuses %s with pinAuthPermitted=%s', async (authProvider, pinAuthPermitted) => {
    mockResolvePrincipal.mockResolvedValueOnce(principal(
      pinAuthPermitted === undefined ? { authProvider } : { authProvider, pinAuthPermitted },
    ));

    await expect(requireMicrosoftOrAttestedLocalPinPrincipal(request())).rejects.toThrow(/^Forbidden/);
  });

  test('an unauthenticated caller is refused as Unauthorized before any credential is read', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    await expect(requireMicrosoftOrAttestedLocalPinPrincipal(request())).rejects.toThrow(/^Unauthorized/);
  });

  // Ordering inherited from requirePrincipal: an attested local session still
  // on its bootstrap PIN is stopped there, before the credential is consulted.
  test('an attested local session on the bootstrap PIN is stopped by requirePrincipal first', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({
      authProvider: 'ppbf_local',
      pinAuthPermitted: true,
      mustChangePin: true,
    }));

    await expect(requireMicrosoftOrAttestedLocalPinPrincipal(request())).rejects.toThrow(/^Forbidden: PIN change/);
  });

  test('the gate reads the attestation and never re-derives it', async () => {
    // No environment, no database, no policy module: with the resolver mocked
    // the gate has nothing else to consult, so admission of an attested local
    // principal here proves it trusted the field alone.
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local', pinAuthPermitted: true }));

    await expect(requireMicrosoftOrAttestedLocalPinPrincipal(request())).resolves.toMatchObject({
      authProvider: 'ppbf_local',
    });
    expect(mockResolvePrincipal).toHaveBeenCalledTimes(1);
  });
});

// Negative control for the scope rule: the Microsoft-only gate is untouched
// and still refuses exactly the principal the new gate admits.
describe('requireMicrosoftAuthenticatedPrincipal stays Microsoft-only', () => {
  test('refuses an attested ppbf_local principal', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local', pinAuthPermitted: true }));

    await expect(requireMicrosoftAuthenticatedPrincipal(request())).rejects.toThrow(
      /Microsoft-authenticated session required/,
    );
  });

  test('still admits a Microsoft principal', async () => {
    const resolved = principal();
    mockResolvePrincipal.mockResolvedValueOnce(resolved);

    await expect(requireMicrosoftAuthenticatedPrincipal(request())).resolves.toBe(resolved);
  });
});
