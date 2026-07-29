import type { NextRequest } from 'next/server';

import { requirePrincipal, requirePrincipalAllowingPinChange } from './http';
import { resolvePrincipal } from './auth';
import { DEFAULT_FIRST_LOGIN_PIN, validatePinPolicy } from './pinPolicy';
import { resolveAuthoritativeRoleSession } from '../../../components/roleSession';

jest.mock('./auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.Mock;

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'nneale',
    role: 'athlete',
    organizationId: 'punxsy_prominence',
    athleteId: 'Neeko-001',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    mustChangePin: false,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

const request = {} as NextRequest;

describe('the bootstrap PIN itself', () => {
  test('satisfies the PIN policy, so nothing downstream needs a special case', () => {
    expect(() => validatePinPolicy(DEFAULT_FIRST_LOGIN_PIN)).not.toThrow();
  });
});

describe('requirePrincipal blocks an account still on the bootstrap PIN', () => {
  test('rejects, so a route cannot serve data to a starting-PIN session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: true }));

    await expect(requirePrincipal(request)).rejects.toThrow('Forbidden: PIN change required');
  });

  test('allows the same account once it has chosen its own PIN', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: false }));

    await expect(requirePrincipal(request)).resolves.toMatchObject({ accountId: 'nneale' });
  });

  // The field is optional on PilotPrincipal so test fixtures elsewhere need not
  // restate it. An absent value must read as "not mid-bootstrap", or every
  // existing route test would start failing.
  test('treats an absent flag as not mid-bootstrap', async () => {
    const withoutFlag = principal();
    delete (withoutFlag as Record<string, unknown>).mustChangePin;
    mockResolvePrincipal.mockResolvedValueOnce(withoutFlag);

    await expect(requirePrincipal(request)).resolves.toMatchObject({ accountId: 'nneale' });
  });

  test('still rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    await expect(requirePrincipal(request)).rejects.toThrow('Unauthorized');
  });
});

describe('requirePrincipalAllowingPinChange', () => {
  test('admits the bootstrap session, so the PIN can actually be changed', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: true }));

    await expect(requirePrincipalAllowingPinChange(request)).resolves.toMatchObject({
      accountId: 'nneale',
      mustChangePin: true,
    });
  });

  test('does not admit an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    await expect(requirePrincipalAllowingPinChange(request)).rejects.toThrow('Unauthorized');
  });
});

describe('client-side session routing', () => {
  test('sends a bootstrap session to the PIN change rather than to a dashboard', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: true,
    });

    expect(resolution).toEqual({ ok: false, reason: 'pin_change_required' });
  });

  // The distinction matters: 'unauthenticated' routes to /login, and signing
  // in again would land right back in the same state -- a loop.
  test('does not report a bootstrap session as unauthenticated', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: true,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).not.toBe('unauthenticated');
  });

  test('routes normally once the athlete has their own PIN', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: false,
    });

    expect(resolution.ok).toBe(true);
  });
});
