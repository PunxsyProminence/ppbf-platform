import type { NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requirePrincipalAllowingPinChange } from './http';
import { resolvePrincipal } from './auth';
import { DEFAULT_FIRST_LOGIN_PIN, assertChosenPinAllowed, validatePinPolicy } from './pinPolicy';
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

describe('the retired bootstrap PIN itself', () => {
  test('is rejected by the general PIN policy', () => {
    expect(() => validatePinPolicy(DEFAULT_FIRST_LOGIN_PIN)).toThrow('starting PIN');
  });
});

// The value remains published so legacy rows can be recognized and rejected.
describe('the retired starting PIN can neither be issued nor chosen', () => {
  test('validatePinPolicy rejects it', () => {
    expect(() => validatePinPolicy(DEFAULT_FIRST_LOGIN_PIN)).toThrow('starting PIN');
  });

  test('choosing it is refused', () => {
    expect(() => assertChosenPinAllowed(DEFAULT_FIRST_LOGIN_PIN))
      .toThrow('PIN cannot be the starting PIN everyone is given. Choose a different one.');
  });

  // The refusal is only useful if the athlete sees it. This used to depend on
  // the message beginning with "PIN", which jsonError prefix-matched to a 400;
  // anything else came back as a 500 with the reason stripped out. It now
  // throws ValidationError, so the status comes from the type and rewording
  // the message can no longer silence it.
  //
  // The body also carries `code` now. That is the point of the machine code
  // moving out of the message prefix: a client can branch on
  // PIN_IS_DEFAULT_FIRST_LOGIN without string-matching prose, which is the
  // same fragility this change removes on the server side.
  test('the refusal reaches the athlete as a 400 carrying the reason', async () => {
    let refusal: unknown;
    try {
      assertChosenPinAllowed(DEFAULT_FIRST_LOGIN_PIN);
    } catch (error) {
      refusal = error;
    }

    const response = jsonError(refusal);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'PIN cannot be the starting PIN everyone is given. Choose a different one.',
      code: 'PIN_IS_DEFAULT_FIRST_LOGIN',
    });
  });

  test('surrounding whitespace does not sneak it past', () => {
    expect(() => assertChosenPinAllowed(`  ${DEFAULT_FIRST_LOGIN_PIN} `)).toThrow('starting PIN');
  });

  test('any other policy-valid PIN is allowed', () => {
    expect(() => assertChosenPinAllowed('428913')).not.toThrow();
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
